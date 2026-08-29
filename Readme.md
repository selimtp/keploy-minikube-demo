# Keploy, Jenkins, and Minikube demo

This project uses Jenkins to build an image, load it into the local Minikube profile, record API traffic with Keploy inside a privileged pod, and replay the generated tests in a Kubernetes Job.

The Kubernetes runner pins the non-interactive open-source Keploy v2 CLI. Keploy v3 prompts for cloud authentication unless credentials are configured; Keploy's cluster-wide Kubernetes Proxy is a separate Enterprise/Self-Hosted product and is not required for this demo.

## 1. Rebuild the existing Jenkins container

The current `jenkins-lab` container needs Docker and Kubectl. The custom image in `jenkins/Dockerfile` installs the required clients. Its Compose file reuses the existing `jenkinslab_jenkins_home` volume, so Jenkins jobs and configuration remain intact.

Run these commands from WSL, not PowerShell:

```bash
docker stop jenkins-lab
docker rm jenkins-lab
cd /path/to/keployApp/jenkins
docker compose build --no-cache
docker compose up -d
```

Removing the old container does not remove `jenkinslab_jenkins_home`; do not run `docker volume rm`.

The Compose file mounts the current WSL user's `~/.kube` and `~/.minikube` directories at the same absolute paths inside Jenkins. It also connects Jenkins to the external `minikube` Docker network.

Verify the rebuilt container:

```bash
docker exec jenkins-lab docker version
docker exec jenkins-lab kubectl --context minikube get nodes
```

If the Compose project containing the existing volume was not named `jenkinslab`, replace `jenkinslab_jenkins_home` in `jenkins/compose.yaml` with the exact volume name reported by `docker inspect`.

## 2. Make the project available to Jenkins

The included Compose file mounts this project at `/workspace/keploy-app`. Create a Jenkins Pipeline job, paste `Jenkinsfile` into **Pipeline script**, and keep the default `SOURCE_DIR`.

For the recommended Git approach, put the project in a repository and create a Jenkins **Pipeline script from SCM** job. Set `SOURCE_DIR` to `.` so Jenkins uses its managed checkout instead.


## 3. Run the pipeline

The pipeline contains these stages:

1. **Verify** checks Docker, Kubectl, and cluster access.
2. **Build App** creates the Keploy-enabled image and loads it directly into the Minikube node's Docker runtime.
3. **Keploy Record** creates an isolated namespace and PVC, starts the app under Keploy, and sends sample requests from another pod.
4. **Keploy Test** replays the recorded cases in a Kubernetes Job and fails Jenkins if Keploy fails.
If the **Keploy Test** Job fails or times out, Jenkins fails immediately and skips any remaining stages.

Every build uses a separate namespace named `keploy-demo-<build-number>`. The `post` block removes the namespace and local images even when a stage fails.

## 4. Build parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `SECURITY_MODE` | `minimal` | Privilege level of the Keploy pods. See below. |
| `ENABLE_NOISE_CONFIG` | checked | Applies `keploy.yml`. Uncheck to demonstrate the failure it prevents. |
| `TEST_DELAY` | `5` | Seconds Keploy waits for the app to boot before replaying. |

### Privilege ladder

`SECURITY_MODE` walks the Keploy pods down from full privilege. Start at `minimal` and step down only when eBPF fails to load:

| Mode | `hostPID` | `securityContext` |
| --- | --- | --- |
| `minimal` | `false` | `runAsUser: 0` plus `BPF`, `PERFMON`, `NET_ADMIN`, `SYS_RESOURCE` |
| `caps-hostpid` | `true` | same capabilities |
| `privileged` | `true` | `privileged: true` |

`minimal` works because Keploy launches the application as its own child process, so both already share a PID namespace. `debugfs` and `tracefs` are supplied as `hostPath` mounts rather than mounted inside the container, which removes the privilege the in-container `mount` calls required. Those calls remain as a fallback and are skipped whenever the host mount succeeded.

`CAP_BPF` requires Linux 5.8 or newer. If Keploy's eBPF loader fails to attach, the pod logs will say so—move one row down the table rather than jumping straight to `privileged`.

If `minimal` fails on a mount permission error instead, the node itself has nothing mounted at those paths, so the `hostPath` volumes are empty and the in-container fallback runs. Mount them once on the node and `minimal` starts working:

```bash
minikube ssh -- "sudo mount -t debugfs debugfs /sys/kernel/debug; sudo mount -t tracefs tracefs /sys/kernel/tracing"
```

This does not survive `minikube stop`. On a real cluster the equivalent is a privileged DaemonSet that prepares the nodes once, which keeps the application pods themselves unprivileged.

### Noise filtering

`POST /notes` returns a `createdAt` timestamp, which differs on every replay. Without `keploy.yml` the recorded and replayed responses never match and the tests fail—the first problem any real service hits. `keploy.yml` marks that field as noise.

Masking the field is not sufficient on its own. Express derives the `Etag` header from a hash of the response body, so a changing `createdAt` produces a changing `Etag` even once the body comparison passes. The symptom is a test that fails on a header diff with no body diff, and with both ETags reporting the same length:

```
EXPECT: W/"66-pC+BGZOo2VL5A49LObgbNtLVp6Q"
ACTUAL: W/"66-t4uyrNNs9W34IrQ8xTHC60lAOZ4"
```

`keploy.yml` therefore lists `Etag` as noise as well. The general rule: anything computed from a noisy field—ETags, `Content-Length`, checksums, signature headers—has to be masked alongside it.

Run the pipeline once with `ENABLE_NOISE_CONFIG` unchecked to see the failure, then once with it checked to see it resolved. When unchecked, the file is deleted inside the pod at startup, so no image rebuild is needed.

## Moving to a JVM application

The eBPF recording layer works at the syscall boundary and is language-agnostic, so the manifests carry over unchanged. Three things do change:

- Set `TEST_DELAY` to 30-60. A Spring Boot context takes far longer to start than Node, and the default of 5 replays traffic against an application that is not listening yet.
- Coverage comes from the JaCoCo agent. Keploy's Java SDK reads JaCoCo's runtime API in-process; it does not replace JaCoCo, it consumes it. Per-testcase deduplication is a Keploy Enterprise feature.
- Connection pools such as HikariCP open long-lived database connections during startup. Keploy mocks at the wire-protocol level so the driver does not matter, but this boot-time behaviour is worth testing early.

## Security

The Jenkins container controls the Docker daemon, and the Keploy pods load eBPF programs. Even at `minimal` the pods run as UID 0 with capabilities that allow kernel-level tracing. Use this only in a trusted local Minikube environment—not on a shared or production cluster.
