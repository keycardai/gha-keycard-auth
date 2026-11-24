#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail
shopt -s inherit_errexit
KEYCARD_ENDPOINT=${KEYCARD_ENDPOINT:-https://api.keycard.ai}
MARKER='Managed by keycardai/gha-keycard-auth acceptance tests (acceptance/zone.sh)'
APP_PREFIX='gha-keycard-auth-acceptance'
RESOURCE_PREFIX='urn:keycard:gha-keycard-auth:acceptance'

mask() {
  if [[ ${GITHUB_ACTIONS:-} == true ]]; then
    local value=$1
    value=${value//'%'/'%25'}
    value=${value//$'\r'/'%0D'}
    value=${value//$'\n'/'%0A'}
    printf '::add-mask::%s\n' "$value" >&2
  fi
}

api() {
  local method=$1 path=$2 body=${3:-} args=()
  [[ -z $body ]] || args=(--data "$body")
  curl --silent --show-error --fail --proto '=https' --connect-timeout 15 --max-time 60 \
    --request "$method" --header "Authorization: Bearer $TOKEN" \
    --header 'Content-Type: application/json' "${args[@]}" "${KEYCARD_ENDPOINT%/}$path"
}

get_token() {
  curl --silent --show-error --fail --proto '=https' --connect-timeout 15 --max-time 60 \
    --data 'grant_type=client_credentials' \
    --data-urlencode "client_id=$KEYCARD_CLIENT_ID" \
    --data-urlencode "client_secret=$KEYCARD_CLIENT_SECRET" \
    "${KEYCARD_ENDPOINT%/}/service-account-token" \
    | jq -er '.access_token | select(type == "string" and length > 0)'
}

items() {
  local path=$1 page cursor='' all='[]'
  while :; do
    page=$(api GET "$path?limit=100${cursor:+&after=$cursor}")
    all=$(jq -nc --argjson a "$all" --argjson p "$page" '$a + $p.items')
    [[ $(jq -r '.page_info.has_next_page // false' <<<"$page") == true ]] || break
    cursor=$(jq -er '.page_info.end_cursor | select(type == "string" and length > 0) | @uri' <<<"$page")
  done
  printf '%s\n' "$all"
}

same() {
  jq -e --argjson want "$1" '
    def clean: walk(if type == "object" then with_entries(select(.value != null)) else . end);
    . as $current | all($want | keys[]; ($current[.] | clean) == ($want[.] | clean))' >/dev/null
}

ensure() {
  local path=$1 want=$2 current id
  want=$(jq -c --arg marker "$MARKER" '. + {description: $marker}' <<<"$want")
  current=$(items "$path" | jq -c --argjson w "$want" '[.[] | select(.identifier == $w.identifier)][0] // empty')
  if [[ -z $current ]]; then
    api POST "$path" "$want" | jq -er .id
  else
    id=$(jq -er .id <<<"$current")
    if [[ $(jq -r '.description // ""' <<<"$current") != "$MARKER" ]]; then
      echo "Refusing to modify unowned object $path/$id: acceptance ownership marker is missing" >&2
      return 1
    fi
    same "$want" <<<"$current" || api PATCH "$path/$id" "$want" >/dev/null
    printf '%s\n' "$id"
  fi
}

ensure_provider() {
  local want=$1 current
  current=$(items "$Z/providers" | jq -c --argjson w "$want" '[.[] | select(.identifier == $w.identifier)][0] // empty')
  if [[ -n $current ]]; then
    jq -er .id <<<"$current"
  else
    want=$(jq -c --arg marker "$MARKER" '. + {description: $marker}' <<<"$want")
    api POST "$Z/providers" "$want" | jq -er .id
  fi
}

credential() {
  local audience=$1 version=${2:-2} current want id
  want=$(jq -nc --arg app "$APP" --arg provider "$PROVIDER" --arg aud "$audience" --argjson version "$version" \
    '{application_id: $app, type: "token", provider_id: $provider, version: $version,
      subject: "repo:keycardai/gha-keycard-auth:*"}
      + if $version == 2 then {allowed_audience: (if $aud == "" then null else $aud end)} else {} end')
  current=$(items "$Z/applications/$APP/application-credentials" | jq -c --argjson w "$want" \
    '[.[] | select(.type == "token" and (.version // 1) == $w.version and .provider_id == $w.provider_id
      and .allowed_audience == $w.allowed_audience)][0] // empty')
  if [[ -z $current ]]; then
    api POST "$Z/application-credentials" "$(jq 'with_entries(select(.value != null))' <<<"$want")" | jq -er .id
  else
    id=$(jq -er .id <<<"$current")
    want=$(jq 'if .version == 2 then {type, version, subject, allowed_audience, authentication_condition: null}
      else {type, subject} end' <<<"$want")
    same "$want" <<<"$current" || api PATCH "$Z/application-credentials/$id" "$want" >/dev/null
    printf '%s\n' "$id"
  fi
}

check_v1() {
  local providers credentials count
  providers=$(items "$Z/providers" | jq -c '[.[] | select(
    .identifier == "https://token.actions.githubusercontent.com" or
    .protocols.oauth2.issuer == "https://token.actions.githubusercontent.com") | .id]')
  credentials=$(items "$Z/application-credentials" | jq -c --argjson providers "$providers" '
    [.[] | select(.type == "token" and (.version // 1) == 1 and
      (.provider_id as $id | $providers | index($id)) != null) |
      (.subject // .identifier // "*") as $subject |
      select(($subject | startswith("repo:keycardai/gha-keycard-auth:")) or
        (($subject | endswith("*")) and
          ("repo:keycardai/gha-keycard-auth:" | startswith($subject | rtrimstr("*")))))]')
  count=$(jq length <<<"$credentials")
  if [[ $count -gt 1 ]]; then
    echo 'Refusing setup: multiple v1 credentials match the GitHub issuer and acceptance subject' >&2
    return 1
  fi
  if [[ $count == 1 ]] && ! jq -e --arg app "$APP" \
    '.[0].application_id == $app and (.[0].subject // .[0].identifier) == "repo:keycardai/gha-keycard-auth:*"' \
    <<<"$credentials" >/dev/null; then
    echo 'Refusing setup: the matching v1 credential does not belong to the stable acceptance fixture' >&2
    return 1
  fi
}

dependency() {
  local resource=$1
  if ! items "$Z/applications/$APP/dependencies" | jq -e --arg id "$resource" 'any(.[]; .id == $id)' >/dev/null; then
    api PUT "$Z/applications/$APP/dependencies/$resource" >/dev/null
  fi
}

up() {
  local suffix
  if [[ -n ${GITHUB_RUN_ID:-} ]]; then
    suffix="$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}"
  else
    suffix="local-$(date +%s)-$$"
  fi
  (umask 077; jq -nc --arg suffix "$suffix" --arg zone "$KEYCARD_ZONE_ID" \
    '{suffix: $suffix, zone: $zone}' > "$STATE_FILE")
  local issuer resource custom default sts audience='https://github.com/keycardai/gha-keycard-auth'
  issuer=$(api GET "$Z" | jq -er '.protocols.oauth2.issuer')
  PROVIDER=$(ensure_provider '{"name":"GitHub Actions","identifier":"https://token.actions.githubusercontent.com","protocols":{"oauth2":{"issuer":"https://token.actions.githubusercontent.com"}}}')
  APP=$(ensure "$Z/applications" "$(jq -nc --arg id "$APP_PREFIX" \
    '{name: "gha-keycard-auth acceptance", identifier: $id}')")
  check_v1
  sts=$(items "$Z/providers" | jq -er '[.[] | select(.type == "keycard-sts")][0].id | select(type == "string")')
  resource=$(ensure "$Z/resources" "$(jq -nc --arg p "$sts" --arg id "$RESOURCE_PREFIX" \
    '{name: "gha-keycard-auth acceptance", identifier: $id, credential_provider_id: $p}')")
  dependency "$resource"
  credential '' 1 >/dev/null
  check_v1
  APP=$(ensure "$Z/applications" "$(jq -nc --arg id "$APP_PREFIX-$suffix" \
    '{name: "gha-keycard-auth acceptance", identifier: $id}')")
  resource=$(ensure "$Z/resources" "$(jq -nc --arg p "$sts" --arg id "$RESOURCE_PREFIX:$suffix" \
    '{name: "gha-keycard-auth acceptance", identifier: $id, credential_provider_id: $p}')")
  dependency "$resource"
  custom=$(credential "$audience")
  default=$(credential '')
  {
    printf 'zone_issuer=%s\ncustom_client_id=%s\ndefault_client_id=%s\n' "$issuer" "$custom" "$default"
    printf 'resource_identifier=%s:%s\ncustom_audience=%s\n' "$RESOURCE_PREFIX" "$suffix" "$audience"
    printf 'v1_resource_identifier=%s\n' "$RESOURCE_PREFIX"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

delete_object() {
  local path=$1 id=$2 identifier=$3 status
  status=$(curl --silent --show-error --proto '=https' --connect-timeout 15 --max-time 60 \
    --request DELETE --header "Authorization: Bearer $TOKEN" \
    --output /dev/null --write-out '%{http_code}' "${KEYCARD_ENDPOINT%/}$path")
  case "$status" in
    204|404) printf 'Deleted %s %s\n' "$id" "$identifier" >&2 ;;
    *) printf 'Failed to delete %s %s (HTTP %s)\n' "$id" "$identifier" "$status" >&2; return 1 ;;
  esac
}

delete_application() {
  local app=$1 identifier=$2 credentials dependencies id
  credentials=$(items "$Z/applications/$app/application-credentials")
  dependencies=$(items "$Z/applications/$app/dependencies")
  while IFS= read -r id; do
    delete_object "$Z/application-credentials/$id" "$id" "$identifier"
  done < <(jq -r '.[].id' <<<"$credentials")
  while IFS= read -r id; do
    delete_object "$Z/applications/$app/dependencies/$id" "$id" "$identifier"
  done < <(jq -r '.[].id' <<<"$dependencies")
  delete_object "$Z/applications/$app" "$app" "$identifier"
}

cleanup() {
  local mode=$1 suffix=${2:-} collection prefix objects object id identifier created cutoff
  cutoff=$(($(date +%s) - 3600))
  for collection in applications resources; do
    if [[ $collection == applications ]]; then prefix=$APP_PREFIX; else prefix=$RESOURCE_PREFIX; fi
    objects=$(items "$Z/$collection")
    while IFS= read -r object; do
      id=$(jq -er .id <<<"$object")
      identifier=$(jq -er .identifier <<<"$object")
      if [[ $mode == down ]]; then
        if [[ $collection == applications ]]; then
          [[ $identifier == "$prefix-$suffix" ]] || continue
        else
          [[ $identifier == "$prefix:$suffix" ]] || continue
        fi
      else
        created=$(jq -er '.created_at | select(type == "string" and length > 0)' <<<"$object") || continue
        created=$(date -d "$created" +%s 2>/dev/null) || continue
        [[ $created -lt $cutoff ]] || continue
      fi
      if [[ $collection == applications ]]; then
        delete_application "$id" "$identifier"
      else
        delete_object "$Z/resources/$id" "$id" "$identifier"
      fi
    done < <(jq -c --arg marker "$MARKER" --arg prefix "$prefix" '
      .[] | select(.description == $marker and
        (.identifier | startswith($prefix + (if $prefix | startswith("urn:") then ":" else "-" end))))' <<<"$objects")
  done
}

down() {
  [[ -f $STATE_FILE ]] || return 0
  local suffix
  suffix=$(jq -er --arg zone "$KEYCARD_ZONE_ID" 'select(.zone == $zone) | .suffix | select(type == "string" and length > 0)' "$STATE_FILE")
  cleanup down "$suffix"
  rm "$STATE_FILE"
}

main() {
  [[ $# == 1 && $1 =~ ^(up|down|sweep)$ ]] || { echo 'usage: acceptance/zone.sh up|down|sweep' >&2; return 2; }
  : "${KEYCARD_CLIENT_ID:?required}" "${KEYCARD_CLIENT_SECRET:?required}"
  : "${KEYCARD_ZONE_ID:?required}"
  STATE_FILE=${KEYCARD_STATE_FILE:-${RUNNER_TEMP:-$HOME}/keycard-acceptance-$KEYCARD_ZONE_ID.json}
  mask "$KEYCARD_CLIENT_SECRET"
  TOKEN=$(get_token)
  mask "$TOKEN"
  Z="/zones/$KEYCARD_ZONE_ID"
  case "$1" in
    up) up ;;
    down) down ;;
    sweep) cleanup sweep ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
