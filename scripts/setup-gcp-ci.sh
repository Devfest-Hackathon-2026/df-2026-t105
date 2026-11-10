#!/bin/sh
# GitHub Actions から Cloud Run へデプロイするための GCP 側の準備（1回だけ実行する）。
# - サイトのパスワードを Secret Manager に登録し、実行用サービスアカウントに読み取りを許可する
# - デプロイ用サービスアカウント ghostnotes-deployer を作り、ソースからのデプロイに必要な権限を付ける
# - Workload Identity Federation で、yi7242/ghostnotes の main からだけ ghostnotes-deployer になれるようにする
# 使い方: APP_PASSWORD=<サイトのパスワード> sh scripts/setup-gcp-ci.sh
set -eu
P=dev-fast-deadline-driven
N=1007513721749
REPO=yi7242/ghostnotes
RUN=ghostnotes-runtime@$P.iam.gserviceaccount.com
BUILD=ghostnotes-build@$P.iam.gserviceaccount.com
DEP=ghostnotes-deployer@$P.iam.gserviceaccount.com
: "${APP_PASSWORD:?APP_PASSWORD を指定してください}"

if gcloud secrets describe ghostnotes-app-password --project $P >/dev/null 2>&1; then
  printf %s "$APP_PASSWORD" | gcloud secrets versions add ghostnotes-app-password --project $P --data-file=-
else
  printf %s "$APP_PASSWORD" | gcloud secrets create ghostnotes-app-password --project $P --replication-policy automatic --data-file=-
fi
gcloud secrets add-iam-policy-binding ghostnotes-app-password --project $P \
  --member "serviceAccount:$RUN" --role roles/secretmanager.secretAccessor >/dev/null

gcloud iam service-accounts describe $DEP --project $P >/dev/null 2>&1 || \
  gcloud iam service-accounts create ghostnotes-deployer --project $P --display-name "Ghostnotes GitHub Actions deployer"
for R in roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $P --member "serviceAccount:$DEP" --role $R --condition=None >/dev/null
done
for SA in $RUN $BUILD; do
  gcloud iam service-accounts add-iam-policy-binding $SA --project $P \
    --member "serviceAccount:$DEP" --role roles/iam.serviceAccountUser >/dev/null
done

gcloud iam workload-identity-pools describe github --project $P --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --project $P --location global --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers describe github --project $P --location global --workload-identity-pool github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc github --project $P --location global \
    --workload-identity-pool github --display-name "GitHub OIDC" \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding $DEP --project $P --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" >/dev/null
echo "準備ができました"
