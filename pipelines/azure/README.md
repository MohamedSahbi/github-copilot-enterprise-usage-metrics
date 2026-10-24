# pipelines/azure

Azure Pipelines support. Provided, community-tested (D-20, D-26).

The pipeline logic is in `scripts/deploy-infra.sh` and `scripts/bootstrap-state.sh`. The Azure Pipelines wrapper that calls them lives in the deployment template repository (`azure-pipelines.yml`), because a deployment repository pins a portal release and runs that release's scripts.
