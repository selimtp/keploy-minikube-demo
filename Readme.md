# Keploy, Jenkins, and Minikube demo

Jenkins builds an image, loads it into the local Minikube profile, records API traffic with Keploy, and replays the generated tests in a Kubernetes Job. The application is a small Notes API backed by Postgres.

The runner pins the non-interactive open-source Keploy v2 CLI. Keploy v3 prompts for cloud authentication unless credentials are configured; Keploy's cluster-wide Kubernetes Proxy is a separate Enterprise/Self-Hosted product and is not required here.

## What this demo establishes

Each of these is exercised by a build parameter and verified in the logs rather than assumed:

| Question | Answer |
| --- | --- |
| Does Keploy need `privileged` pods? | No. It runs with four capabilities and no `hostPID`. |
| Does it ignore values that legitimately change? | Yes, and it detects most of them without configuration. |
| Does it catch a real regression? | Yes, confirmed with `INJECT_REGRESSION`. |
| Does it report coverage? | Yes, through the language's own tool—`nyc` here, JaCoCo on the JVM. |
| Does it mock the database? | The replay Job runs with no Postgres at all. If it passes, every query came from a recorded mock. |

## 1. Rebuild the Jenkins container

The `jenkins-lab` container needs the Docker and Kubectl clients, which `jenkins/Dockerfile.jenkins` installs. The Compose file reuses the existing `jenkinslab_jenkins_home` volume, so jobs and configuration survive.

Run from WSL, not PowerShell:

```bash
docker stop jenkins-lab
docker rm jenkins-lab
cd /path/to/keployApp/jenkins
docker compose build --no-cache
docker compose up -d
```

Removing the container does not remove `jenkinslab_jenkins_home`; do not run `docker volume rm`. If the Compose project holding that volume was not named `jenkinslab`, replace the name in `jenkins/compose.yaml` with what `docker inspect` reports.

The Compose file mounts the WSL user's `~/.kube` and `~/.minikube` at the same absolute paths inside Jenkins and joins the container to the external `minikube` Docker network. Verify:

```bash
docker exec jenkins-lab docker version
docker exec jenkins-lab kubectl --context minikube get nodes
```

## 2. Create the Jenkins job

Use a **Pipeline script from SCM** job pointing at the repository, and **set `SOURCE_DIR` to `.`** so the pipeline uses Jenkins' own checkout. The default `/workspace/keploy-app` is the Compose bind mount, which only applies to the paste-the-Jenkinsfile-inline setup.

Two things about parameters that cost real debugging time:

- Jenkins updates a job's parameter definitions **after** a build completes. A newly added parameter is not available on the first build following the push; it appears from the second onwards.
- **Build Now** skips the parameter form and uses defaults. Use **Build with Parameters** whenever a non-default value matters.

The record stage echoes the effective values, so check the top of the log rather than trusting the form.

## 3. Pipeline stages

1. **Verify** — checks Docker, Kubectl, cluster access, and that the expected files exist.
2. **Build App** — builds the Keploy image and loads it into the Minikube node's Docker runtime, then does the same for the Postgres image so the node needs no registry access.
3. **Keploy Record** — creates an isolated namespace, starts Postgres, waits for it, starts the app under Keploy, drives traffic from a separate pod, then deletes the recorder.
4. **Keploy Test** — dumps the recorded test cases and mock summary, replays in a Job, reports coverage, and fails Jenkins if Keploy fails.

Every build uses a namespace named `keploy-demo-<build-number>`. The `post` block removes the namespace and the app image even when a stage fails.

## 4. Build parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `SOURCE_DIR` | `/workspace/keploy-app` | Set to `.` for an SCM job. |
| `SECURITY_MODE` | `minimal` | Privilege level of the Keploy pods. |
| `ENABLE_NOISE_CONFIG` | checked | Applies `keploy.yml`. |
| `TEST_DELAY` | `5` | Seconds Keploy waits for the app to boot. Use 30-60 for a JVM. |
| `INJECT_REGRESSION` | unchecked | Breaks `/health` during replay. A red build is the expected result. |

### Privilege ladder

Start at `minimal` and step down only when eBPF fails to load:

| Mode | `hostPID` | `securityContext` |
| --- | --- | --- |
| `minimal` | `false` | `runAsUser: 0` plus `BPF`, `PERFMON`, `NET_ADMIN`, `SYS_RESOURCE` |
| `caps-hostpid` | `true` | same capabilities |
| `privileged` | `true` | `privileged: true` |

`minimal` works because Keploy launches the application as its own child process, so the two already share a PID namespace. `debugfs` and `tracefs` arrive as `hostPath` mounts instead of being mounted inside the container, which removes the privilege the in-container `mount` calls needed. Those calls remain as a fallback and are skipped whenever the host mount succeeded.

`CAP_BPF` requires Linux 5.8 or newer. If Keploy's eBPF loader cannot attach, the pod logs say so—move one row down rather than jumping to `privileged`.

If `minimal` fails on a mount permission error instead, the node has nothing mounted at those paths, so the `hostPath` volumes are empty and the fallback runs. Mount them once on the node:

```bash
minikube ssh -- "sudo mount -t debugfs debugfs /sys/kernel/debug; sudo mount -t tracefs tracefs /sys/kernel/tracing"
```

This does not survive `minikube stop`. On a real cluster the equivalent is a privileged DaemonSet that prepares nodes once, leaving the application pods unprivileged.

### Noise filtering

`POST /notes` returns a `createdAt` timestamp that differs on every replay.

Keploy handles the field itself. At record time it detects timestamp-like values and writes them into the test case, which is why the generated test for `POST /notes` contains this with nothing configured:

```yaml
    assertions:
        noise:
            body.createdAt: []
            header.Date: []
```

The tests for `/health` and `GET /notes` carry only `header.Date`, because their bodies contain no timestamp. Detection is per-response, not a blanket rule.

What Keploy does not detect is a value *derived* from a noisy field. Express computes `Etag` as a hash of the response body, so a changing `createdAt` yields a changing `Etag` even though the body comparison passes. The symptom is a failure on a header diff with no body diff, both ETags reporting the same length:

```
EXPECT: W/"66-pC+BGZOo2VL5A49LObgbNtLVp6Q"
ACTUAL: W/"66-t4uyrNNs9W34IrQ8xTHC60lAOZ4"
```

`Etag` is therefore the only entry in `keploy.yml`. The rule: anything computed from a noisy field—ETags, checksums, signature headers, `Content-Length` where the length is not fixed—has to be masked by hand.

Automatic detection cuts both ways. A field Keploy decides is a timestamp gets masked whether or not its value matters to you, and a wrong value there passes silently. Read the `assertions.noise` block of the generated tests before trusting a green run.

Run once with `ENABLE_NOISE_CONFIG` unchecked to see the failure, then once checked to see it resolved. Unchecked, the file is deleted inside the pod at startup, so no image rebuild is needed.

### Regression canary

Noise filtering answers "does Keploy ignore what should be ignored". `INJECT_REGRESSION` answers the more important opposite: does it catch a change that matters.

When checked, the test pod runs `sed -i s/ok/healthy/ /app/app.js` before replaying. The edit lands only in the test pod and only after recording, so the recorded expectation still reads `{"status":"ok"}` while the replayed application answers `{"status":"healthy"}`. `ok` appears nowhere else in `app.js`, so the unquoted expression touches only that line—no shell quoting to get wrong across the Groovy, shell, sed and YAML layers.

`/health` was chosen because its test carries only `header.Date` as noise and does not touch the database. Nothing is auto-masked, so the comparison is genuinely exercised.

Read the outcome backwards from a normal build:

| Outcome | Meaning |
| --- | --- |
| The `/health` test fails on a body diff | Correct. Keploy detects real changes. |
| Build is green | Verify the `/health source after regression setup` block actually reads `healthy`. If it reads `ok`, the substitution never ran and the experiment proved nothing. |

Expect the diff to cover the body and `Content-Length` (15 bytes becomes 20). `Etag` changes too but is masked.

### Coverage

`Dockerfile.keploy` installs `nyc`, which is what Keploy shells out to for JavaScript coverage. Without it the log reads `coverage tool not found, skipping coverage caluclation` and no report is produced. The JVM equivalent is the JaCoCo agent.

The report is the most useful artifact for comparing Keploy against an existing JaCoCo setup, because it shows the shape of what recorded traffic reaches. The traffic generator calls `/health`, `GET /notes`, `POST /notes` and `GET /notes/1`, so the report consistently shows:

- `DELETE /notes/:id` — never executed
- the `404` and `400` branches — never executed

That is the argument for keeping both tools. Keploy tests the paths that receive traffic; the paths JaCoCo shows as uncovered by unit tests are frequently the same paths no traffic ever reaches. Neither tool sees what the other sees.

### Dependency mocking

The application talks to Postgres, and this is the part of Keploy that matters most in production.

`k8s/record.yaml` deploys Postgres alongside the recorder and an init container blocks the app until `pg_isready` succeeds—without it the app's failed connection retries end up in the recorded mocks.

`k8s/test.yaml` deploys **no Postgres at all**. If the replay passes there, every query, including the `CREATE TABLE` issued before `listen`, was served from `mocks.yaml`. The Job prints a summary of the recorded mocks by kind before replaying, so the Postgres traffic is visible in the log rather than inferred.

Keploy intercepts at the wire-protocol level rather than through the driver, so this result carries to any language that speaks the same protocol.

## Moving to a JVM application

The eBPF recording layer works at the syscall boundary and is language-agnostic, so the manifests carry over unchanged. What changes:

- `TEST_DELAY` becomes 30-60. A Spring Boot context takes far longer to start than Node, and the default of 5 replays traffic against an application that is not listening yet. This is the single most common cause of a confusing first failure on the JVM.
- Coverage comes from the JaCoCo agent instead of `nyc`. Keploy's Java SDK reads JaCoCo's runtime API in-process; it consumes JaCoCo rather than replacing it. Per-testcase deduplication is a Keploy Enterprise feature.
- Connection pools such as HikariCP open long-lived connections during startup, so more of the database conversation happens before the first request than it does here.
- The traffic generator runs `node -e` against the application image. A JVM image has no `node`, so it has to be rewritten with `curl` or moved to its own image.

## Security

The Jenkins container controls the Docker daemon, and the Keploy pods load eBPF programs. Even at `minimal` they run as UID 0 with capabilities allowing kernel-level tracing. Use this only in a trusted local Minikube environment—not on a shared or production cluster.

`k8s/record.yaml` contains a hardcoded Postgres password. It is a throwaway database in a namespace deleted at the end of every build; do not copy the pattern into anything longer-lived.
