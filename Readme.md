# Keploy, Jenkins, and Minikube demo

This project uses Jenkins to build an image, load it into the local Minikube profile, record API traffic with Keploy inside a privileged pod, and replay the generated tests in a Kubernetes Job.

The Kubernetes runner uses open-source Keploy. Keploy's cluster-wide Kubernetes Proxy is a separate Enterprise/Self-Hosted product and is not required for this demo.

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

## Security

The Jenkins container controls the Docker daemon, and the Keploy pods are privileged with host PID access because Keploy uses eBPF. Use this only in a trusted local Minikube environment—not on a shared or production cluster.
