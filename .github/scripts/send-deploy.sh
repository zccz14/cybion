#!/usr/bin/env bash
set -euo pipefail

instance_id="${1:?EC2 instance ID is required}"
tag="${2:?release tag is required}"
repository="${GITHUB_REPOSITORY:?GitHub repository is required}"
server_url="${GITHUB_SERVER_URL:-https://github.com}"
archive="cybion-linux-x86_64.tar.gz"
archive_url="$server_url/$repository/releases/download/$tag/$archive"
checksum_url="$archive_url.sha256"
script_base64="$(base64 < deploy/deploy-release.sh | tr -d '\n')"

printf -v quoted_tag '%q' "$tag"
printf -v quoted_archive_url '%q' "$archive_url"
printf -v quoted_checksum_url '%q' "$checksum_url"
install_command="printf '%s' '$script_base64' | base64 -d > /tmp/cybion-deploy.sh && chmod 700 /tmp/cybion-deploy.sh"
run_command="bash /tmp/cybion-deploy.sh $quoted_tag $quoted_archive_url $quoted_checksum_url"
parameters="$(jq -cn --arg install "$install_command" --arg run "$run_command" '{commands:[$install,$run]}')"

command_id="$(aws ssm send-command \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Deploy Cybion $tag" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

for _ in $(seq 1 90); do
  state="$(aws ssm get-command-invocation \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query Status \
    --output text)"
  case "$state" in
    Success)
      aws ssm get-command-invocation \
        --command-id "$command_id" \
        --instance-id "$instance_id" \
        --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}'
      exit 0
      ;;
    Failed|Cancelled|TimedOut|Cancelling)
      aws ssm get-command-invocation \
        --command-id "$command_id" \
        --instance-id "$instance_id" \
        --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}'
      exit 1
      ;;
  esac
  sleep 2
done

echo "SSM command $command_id did not finish within the deployment window." >&2
exit 1
