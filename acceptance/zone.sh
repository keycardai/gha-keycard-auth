#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail
shopt -s inherit_errexit

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
    --header 'Content-Type: application/json' "${args[@]}" "${KEYCARD_API_URL%/}$path"
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
  current=$(items "$path" | jq -c --argjson w "$want" '[.[] | select(.identifier == $w.identifier)][0] // empty')
  if [[ -z $current ]]; then
    api POST "$path" "$want" | jq -er .id
  else
    id=$(jq -er .id <<<"$current")
    same "$want" <<<"$current" || api PATCH "$path/$id" "$want" >/dev/null
    printf '%s\n' "$id"
  fi
}

credential() {
  local audience=$1 version=${2:-2} current want id
  want=$(jq -nc --arg app "$APP" --arg provider "$PROVIDER" --arg aud "$audience" --argjson version "$version" \
    '{application_id: $app, type: "token", provider_id: $provider, version: $version,
      subject: "repo:keycardai/gha-keycard-auth:*"}
      + if $version == 2 then {allowed_audience: (if $aud == "" then null else $aud end)} else {} end')
  current=$(items "$Z/applications/$APP/application-credentials" | jq -c --argjson w "$want" \
    '[.[] | select(.type == "token" and .version == $w.version and .provider_id == $w.provider_id
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

main() {
  [[ ${1:-} == up && $# == 1 ]] || { echo 'usage: acceptance/zone.sh up' >&2; return 2; }
  : "${KEYCARD_CLIENT_ID:?required}" "${KEYCARD_CLIENT_SECRET:?required}"
  : "${KEYCARD_TOKEN_ENDPOINT:?required}" "${KEYCARD_API_URL:?required}" "${KEYCARD_ZONE_ID:?required}"
  mask "$KEYCARD_CLIENT_SECRET"
  TOKEN=$(curl --silent --show-error --fail --proto '=https' --connect-timeout 15 --max-time 60 \
    --user "$KEYCARD_CLIENT_ID:$KEYCARD_CLIENT_SECRET" --data 'grant_type=client_credentials' \
    "$KEYCARD_TOKEN_ENDPOINT" | jq -er '.access_token | select(type == "string" and length > 0)')
  mask "$TOKEN"
  Z="/zones/$KEYCARD_ZONE_ID"
  local issuer resource custom default sts audience='https://github.com/keycardai/gha-keycard-auth'
  issuer=$(api GET "$Z" | jq -er '.protocols.oauth2.issuer')
  PROVIDER=$(ensure "$Z/providers" '{"name":"GitHub Actions","identifier":"https://token.actions.githubusercontent.com","protocols":{"oauth2":{"issuer":"https://token.actions.githubusercontent.com"}}}')
  APP=$(ensure "$Z/applications" '{"name":"gha-keycard-auth acceptance","identifier":"gha-keycard-auth-acceptance"}')
  sts=$(items "$Z/providers" | jq -er '[.[] | select(.type == "keycard-sts")][0].id | select(type == "string")')
  resource=$(ensure "$Z/resources" "$(jq -nc --arg p "$sts" \
    '{name: "gha-keycard-auth acceptance", identifier: "urn:keycard:gha-keycard-auth:acceptance", credential_provider_id: $p}')")
  if ! items "$Z/applications/$APP/dependencies" | jq -e --arg id "$resource" 'any(.[]; .id == $id)' >/dev/null; then
    api PUT "$Z/applications/$APP/dependencies/$resource" >/dev/null
  fi
  custom=$(credential "$audience")
  default=$(credential '')
  credential '' 1 >/dev/null
  {
    printf 'zone_issuer=%s\ncustom_client_id=%s\ndefault_client_id=%s\n' "$issuer" "$custom" "$default"
    printf 'resource_identifier=urn:keycard:gha-keycard-auth:acceptance\ncustom_audience=%s\n' "$audience"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
