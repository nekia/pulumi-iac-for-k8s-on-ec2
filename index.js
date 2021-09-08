const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");

const allowedIngressIpv4Range = require("./allowed-ingress-ipv4range.json");

let size = "t2.xlarge";     // t2.micro is available in the AWS free tier

let ami = pulumi.output(aws.ec2.getAmi({
    filters: [{
      name: "name",
      values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-20210825"],
    }],
    owners: ["099720109477"], // This owner ID is Amazon
    mostRecent: true,
}));

let group = new aws.ec2.SecurityGroup("webserver-secgrp", {
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: allowedIngressIpv4Range.range },
    { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: allowedIngressIpv4Range.range },
    { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: allowedIngressIpv4Range.range },
    { protocol: "tcp", fromPort: 30080, toPort: 30080, cidrBlocks: allowedIngressIpv4Range.range },

    // Github hooks
    {
      protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: [
        "192.30.252.0/22",
        "185.199.108.0/22",
        "140.82.112.0/20",
        "143.55.64.0/20",
      ], ipv6CidrBlocks: [
        "2a0a:a440::/29",
        "2606:50c0::/32"
      ]
    },
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],

});

const deployer = new aws.ec2.KeyPair(process.env.PUBLIC_KEY_NAME, {
    publicKey: process.env.PUBLIC_KEY_STR, 
});

let provisioningScript =
`#!/bin/bash

## Download and Install prerequisite tools and packages ##

# Container runtime (Docker)
apt-get update
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  lsb-release
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io

# kubeadm/kubectl/kubelet
apt-get update
apt-get install -y apt-transport-https ca-certificates curl
curl -fsSLo /usr/share/keyrings/kubernetes-archive-keyring.gpg https://packages.cloud.google.com/apt/doc/apt-key.gpg
echo "deb [signed-by=/usr/share/keyrings/kubernetes-archive-keyring.gpg] https://apt.kubernetes.io/ kubernetes-xenial main" | tee /etc/apt/sources.list.d/kubernetes.list
apt-get update
apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl

usermod -aG docker ubuntu
mkdir /etc/docker 2>/dev/null

# For Docker engine, configure to use "systemd" cgroup driver
cat <<EOF | tee /etc/docker/daemon.json
{
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m"
  },
  "storage-driver": "overlay2"
}
EOF
systemctl daemon-reload
systemctl restart docker.service

# Start k8s cluster
kubeadm init --pod-network-cidr=192.168.0.0/16 > /tmp/kubeadmin.log 2>&1
export KUBE_USER=ubuntu
export KUBE_USER_HOME=/home/$KUBE_USER
mkdir -p $KUBE_USER_HOME/.kube
cp -i /etc/kubernetes/admin.conf $KUBE_USER_HOME/.kube/config
chown -R $KUBE_USER:$KUBE_USER $KUBE_USER_HOME/.kube
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl taint node $(kubectl get nodes -o jsonpath={.items[].metadata.name}) node-role.kubernetes.io/master:NoSchedule-

# Install CNI : Calico
kubectl apply -f https://docs.projectcalico.org/manifests/tigera-operator.yaml
kubectl apply -f https://docs.projectcalico.org/manifests/custom-resources.yaml

# Instlal yq to manipulate YAML file
wget https://github.com/mikefarah/yq/releases/download/v4.13.0/yq_linux_amd64
mv ./yq_linux_amd64 /usr/local/bin/yq
chmod +x /usr/local/bin/yq

# Download manifest of Ingress Controller and modify to use host network
wget https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.0.0/deploy/static/provider/cloud/deploy.yaml
yq e -i '(select( .kind == "Deployment" ) | .spec.template.spec.hostNetwork) = true' deploy.yaml
yq e -i '(select( .kind == "Deployment" ) | .spec.template.spec.dnsPolicy) = "ClusterFirstWithHostNet"' deploy.yaml
yq e -i '(select( .kind == "Deployment" ) | .spec.template.spec.containers[0].args) |= . + ["--enable-ssl-passthrough"]' deploy.yaml
kubectl apply -f deploy.yaml

# Setup Flux and repo
curl -s https://fluxcd.io/install.sh | bash
export GITHUB_TOKEN=${process.env.GITHUB_TOKEN}
export GITHUB_USER=${process.env.GITHUB_USER}
flux bootstrap github \
  --owner=$GITHUB_USER \
  --repository=fleet-infra \
  --branch=main \
  --path=./clusters/my-cluster \
  --personal

# Setup ArgoCD CLI
curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x /usr/local/bin/argocd

# Setup auto completions
cat <<EOF >> /home/ubuntu/.bashrc
. <(kubectl completion bash)
. <(flux completion bash)
. <(argocd completion bash)
alias k=kubectl
complete -F __start_kubectl k
EOF
`;

let server = new aws.ec2.Instance("webserver-www", {
    instanceType: size,
    vpcSecurityGroupIds: [ group.id ], // reference the security group resource above
    ami: ami.id,
    userData: provisioningScript,
    keyName: deployer.keyName,
    rootBlockDevice: {
        volumeSize: 32,
    },
});

exports.publicIp = server.publicIp;
exports.publicHostName = server.publicDns;
