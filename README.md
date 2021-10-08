# How to bring up a cluster

* Fork the following repositories on Github:
  * https://github.com/nekia/fleet-infra
  * https://github.com/nekia/my-cicd-env
  * https://github.com/nekia/my-app-env
  * https://github.com/nekia/airtng-node

* In `my-app-env` repository, also need to update some repository URLs to your repository URLs in some manifest files

  ```
  my-app-env/myapps.yaml
    11,33:     repoURL: https://github.com/nekia/my-app-env.git

  my-app-env/argocd-apps/app.yaml
    13,33:     repoURL: https://github.com/nekia/my-app-env.git

  my-app-env/argocd-apps/backend.yaml
    13,33:     repoURL: https://github.com/nekia/my-app-env.git

  my-app-env/argocd-apps/messaging.yaml
    13,33:     repoURL: https://github.com/nekia/my-app-env.git

  my-app-env/myapps/app/app-deploy.yaml
    22,16:       - image: nekia/my-airtng-node:1.0.0
  ```

* Set the following environment variables in `envsetup.rc`:
  * PUBLIC_KEY_NAME
  * PUBLIC_KEY_STR
    * `ssh-keygen -y -f ~/.ssh/<private key file>`
  * GITHUB_TOKEN
  * GITHUB_USER

* Run `source ./envsetup.rc`
* Replace a series of IP address (network address) in `allowed-ingress-ipv4range.json` which are allowed to access to ingress.
* Run `pulumi up`
* After moving to cicd-iac repo cloned locally, update IP address of VM in Ingress manifest and commit and push the change.
  ```
  my-cicd-env/argo-wf-ingress.yaml
    14,18:     - host: cicd.13.208.247.116.nip.io
    37,21:     - host: webhook.13.208.247.116.nip.io

  my-cicd-env/setup-cd/argocd-wf-ingress.yaml
    12,20:     - host: argocd.13.208.247.116.nip.io

  airtng-node/lib/notifier.js
    5,26: const opts = { servers: "13.208.247.116.nip.io:30080" };
    78,18:     "<http://app.13.208.247.116.nip.io/sessions/answer?employeeid=12345|Reply accept or reject>";

  my-app-env/myapps/app/app-ingress.yaml
    11,17:     - host: app.13.208.247.116.nip.io
  ```
  * The change will be automatically reflected on the K8s cluster via Flux.

* Log in the VM created via Pulumi with the following command,

  ```
  ssh -i ~/.ssh/<private key file> ubuntu@13.208.247.116
  ```

* After logging in, need to apply the following 2 secret resources. Run the following commands:

  * **Important Note:** Currently, in our steps, Docker user name needs to be identical to Github user name.

  ```
  # Credential for pushing built image into docker hub
  {
  export DOCKER_USER="<your docker hub username>"
  export DOCKER_PASSWD="<your docker hub password>"
  cat <<EOF > dockerconfig.json
  {
    "auths": {
      "https://index.docker.io/v1/": {
        "auth": "$(echo -n "$DOCKER_USER:$DOCKER_PASSWD" | base64)"
      }
    }
  }
  EOF
  kubectl create secret generic regcred --from-file=dockerconfig.json -n argo-events
  }
  ```

  ```
  # Credential for posting message into a slack workspace
  {
  export SLACKAPPOAUTHTOKEN="<your slack app oauth token>"
  cat <<EOF | kubectl apply -n argo-events -f -
  apiVersion: v1
  kind: Secret
  metadata:
    name: slack-secret
  data:
    token: $(echo $SLACKAPPOAUTHTOKEN | base64 -w 0)
  EOF
  }
  ```

* Update WebHook URL placed in the repository of the application with the webhook ingress (e.g. `http://webhook.13.208.247.116.nip.io/example`)
  * e.g. https://github.com/nekia/airtng-node/settings/hooks


* Retrieve admin password of Argo CD with the following command:

  ```
  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d && echo
  ```

* Go to Argo CD dashboard (e.g. https://argocd.13.208.247.116.nip.io) and login with `admin` user and the retrieved password:

  ![](assets/step%20(0).png)

* Create a new app by clicking `+NEW APP`:

  ![](assets/step%20(1).png)

* Navigate to YAML Edit mode by selecting `EDIT AS YAML` on right upper corner:

  ![](assets/step%20(2).png)

* Replace the initial snippet with the following YAML and click `CREATE`:

  ```yaml
  apiVersion: argoproj.io/v1alpha1
  kind: Application
  metadata:
    name: my-app-set
  spec:
    destination:
      name: ''
      namespace: argocd
      server: 'https://kubernetes.default.svc'
    source:
      path: argocd-apps
      repoURL: 'https://github.com/nekia/my-app-env'
      targetRevision: HEAD
    project: default
    syncPolicy:
      automated:
        prune: false
        selfHeal: false
  ```

  ![](assets/step%20(6).png)

* Click `SYNC APPS`:

  ![](assets/step%20(3).png)

* Choose all of APPS and click `SYNC`:

  ![](assets/step%20(4).png)

* After waiting for a few minutes, you can see all of apps are synced as follow:

  ![](assets/step%20(5).png)
# Tips

* To make good productivity on the VM, run the following commands when log in your first time:

  ```
  {
  . <(kubectl completion bash)
  . <(flux completion bash)
  . <(argocd completion bash)
  alias k=kubectl
  complete -F __start_kubectl k
  }
  ```

* To develop code with Git in a VM instance, you can create a portable git bundle file with the following commands:

  ```
  # To export a specific branch to a bundle file
  git bundle create ./20210921-master.bundle master

  # Copy this bundle file via S3 bucket
  #  e.g.   aws s3 cp s3://graduated-dev/20210921-master.bundle .

  # To import a bundle file into  local file system as a git repository
  git clone ./20210921-master.bundle -b master
  ```