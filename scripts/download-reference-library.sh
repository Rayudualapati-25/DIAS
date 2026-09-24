#!/usr/bin/env bash

set -euo pipefail

repo_dir="/Users/venkatrayudu/Workspace/XAI workspace/DIAS"
bib_file="$repo_dir/papers/final_paper/dias-refs.bib"
library_dir="$repo_dir/papers/reference_library"
active_dir="$library_dir/01_cited_in_current_manuscript"
supporting_dir="$library_dir/02_supporting_bibliography"
benchmark_dir="$library_dir/03_methodology_and_benchmark_papers"
manifest="$library_dir/manifest.csv"
tmp_dir="$(mktemp -d)"

mkdir -p "$active_dir" "$supporting_dir" "$benchmark_dir"

printf '%s\n' 'category,bibtex_key,title,doi,source_url,status,local_file,sha256,notes' > "$manifest"

csv_escape() {
  local value="${1:-}"
  value=${value//\"/\"\"}
  printf '"%s"' "$value"
}

append_manifest() {
  local category="$1"
  local key="$2"
  local title="$3"
  local doi="$4"
  local source_url="$5"
  local status="$6"
  local local_file="$7"
  local sha256="$8"
  local notes="$9"

  {
    csv_escape "$category"; printf ','
    csv_escape "$key"; printf ','
    csv_escape "$title"; printf ','
    csv_escape "$doi"; printf ','
    csv_escape "$source_url"; printf ','
    csv_escape "$status"; printf ','
    csv_escape "$local_file"; printf ','
    csv_escape "$sha256"; printf ','
    csv_escape "$notes"; printf '\n'
  } >> "$manifest"
}

is_active_key() {
  case "$1" in
    Rose2020|Gai2023|Hu2014|CJIS2024|Cheng2025|Fleming2025|Zisad2026|Ghaffari2023|Ramazhamba2023|Akbarfam2023|Kumar2025|Maesa2019b|Guo2019|Sengupta2025|Mukherjee2020|Nekouie2026|Wachter2018|HaselMehri2025|HaselMehri2026|Chowdary2026|Vasconcelos2023|Pasdar2023|Manavi2026|Greshake2023|Groschupp2025|Debenedetti2025|Rostad2006|Brucker2009|Ferreira2009|AlAmin2025|Xu2018|Androulaki2018|Qwen3TR2025)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

manual_pdf_url() {
  case "$1" in
    Rose2020)
      printf '%s' 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf'
      ;;
    Hu2014)
      printf '%s' 'https://nvlpubs.nist.gov/nistpubs/specialpublications/NIST.SP.800-162.pdf'
      ;;
    CJIS2024)
      printf '%s' 'https://le.fbi.gov/file-repository/cjis_security_policy_v6-0_20241227.pdf'
      ;;
    Ramazhamba2023)
      printf '%s' 'https://researchspace.csir.co.za/bitstream/handle/10204/13368/RS_27272_NGEI_A%20Blockchain%20Model%20for%20Sharing%20Information%20In%20Criminal%20Justice%20Systems_202310.pdf'
      ;;
    Akbarfam2023)
      printf '%s' 'https://arxiv.org/pdf/2308.03927'
      ;;
    Guo2019)
      printf '%s' 'https://arxiv.org/pdf/1906.01188'
      ;;
    Mukherjee2020)
      printf '%s' 'https://www.sinconf.org/sin2020/docs/4.pdf'
      ;;
    Wachter2018)
      printf '%s' 'https://arxiv.org/pdf/1711.00399'
      ;;
    Vasconcelos2023)
      printf '%s' 'https://arxiv.org/pdf/2212.06823'
      ;;
    Pasdar2023)
      printf '%s' 'https://aglive.com/wp-content/uploads/2023/04/Amir_ACM_Comp__Sur___Blockchain_Oracle_Design_Patterns.pdf'
      ;;
    Greshake2023)
      printf '%s' 'https://arxiv.org/pdf/2302.12173'
      ;;
    Rostad2006)
      printf '%s' 'https://cs.uwaterloo.ca/twiki/pub/Main/MaxwellYoung/Study_Rostad.pdf'
      ;;
    Ferreira2009)
      printf '%s' 'https://kar.kent.ac.uk/id/document/14091'
      ;;
    AlAmin2025)
      printf '%s' 'https://www.scitepress.org/Papers/2025/135270/135270.pdf'
      ;;
    Xu2018)
      printf '%s' 'https://arxiv.org/pdf/1804.09267'
      ;;
    Cheng2025)
      printf '%s' 'https://arxiv.org/pdf/2505.23835'
      ;;
    Fleming2025)
      printf '%s' 'https://arxiv.org/pdf/2510.11414'
      ;;
    Zisad2026)
      printf '%s' 'https://arxiv.org/pdf/2602.09392'
      ;;
    Chowdary2026)
      printf '%s' 'https://arxiv.org/pdf/2604.12850'
      ;;
    Groschupp2025)
      printf '%s' 'https://arxiv.org/pdf/2511.20284'
      ;;
    Debenedetti2025)
      printf '%s' 'https://arxiv.org/pdf/2503.18813'
      ;;
    Androulaki2018)
      printf '%s' 'https://arxiv.org/pdf/1801.10228'
      ;;
    Qwen3TR2025)
      printf '%s' 'https://arxiv.org/pdf/2505.09388'
      ;;
    Chen2025StruQ)
      printf '%s' 'https://www.usenix.org/system/files/usenixsecurity25-chen-sizhe.pdf'
      ;;
    Ongaro2014)
      printf '%s' 'https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf'
      ;;
    Hu2022LoRA)
      printf '%s' 'https://arxiv.org/pdf/2106.09685'
      ;;
    Dettmers2023QLoRA)
      printf '%s' 'https://arxiv.org/pdf/2305.14314'
      ;;
    Liu2024PI)
      printf '%s' 'https://www.usenix.org/system/files/usenixsecurity24-liu-yupei.pdf'
      ;;
    Kapoor2023)
      printf '%s' 'https://par.nsf.gov/servlets/purl/10513990'
      ;;
    Brodersen2010)
      printf '%s' 'https://cheng-soon.ong-home.my/papers/brodersen10post-balacc.pdf'
      ;;
    Wilson1927)
      printf '%s' 'https://jhanley.biostat.mcgill.ca/c607/ch08/wilson_jasa_1927.pdf'
      ;;
    Sun2024zkLLM)
      printf '%s' 'https://arxiv.org/pdf/2404.16109'
      ;;
    Chen2024ZKML)
      printf '%s' 'https://ddkang.github.io/papers/2024/zkml-eurosys.pdf'
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}

download_pdf() {
  local url="$1"
  local destination="$2"
  local partial="$destination.partial"

  rm -f "$partial"
  if ! curl -L --fail --silent --show-error --retry 1 --connect-timeout 15 --max-time 90 \
    --compressed \
    -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36' \
    "$url" -o "$partial"; then
    rm -f "$partial"
    return 1
  fi

  if ! head -c 5 "$partial" | grep -q '%PDF-'; then
    rm -f "$partial"
    return 1
  fi

  mv "$partial" "$destination"
  return 0
}

openalex_pdf_url() {
  local doi="$1"
  local encoded_doi
  encoded_doi=$(jq -rn --arg value "https://doi.org/$doi" '$value|@uri')
  curl -L --fail --silent --show-error --retry 2 \
    "https://api.openalex.org/works/$encoded_doi" \
    | jq -r '[.best_oa_location.pdf_url, (.locations[]?.pdf_url)] | map(select(. != null and . != "")) | first // empty' \
    || true
}

perl -0777 -ne '
  while (/\@\w+\{([^,]+),(.*?)(?=\n\@|\z)/sg) {
    $key = $1;
    $body = $2;
    ($title) = $body =~ /title\s*=\s*\{(.*?)\}\s*,/s;
    ($doi) = $body =~ /doi\s*=\s*\{(.*?)\}/s;
    ($url) = $body =~ /url\s*=\s*\{(.*?)\}/s;
    $title //= "";
    $doi //= "";
    $url //= "";
    $title =~ s/[{}]//g;
    $title =~ s/\\allowbreak//g;
    $title =~ s/\\&/and/g;
    $title =~ s/\\[`"^~=.cvHkruvbdo]\s*\{?([A-Za-z])\}?/$1/g;
    $title =~ s/\s+/ /g;
    $title =~ s/^\s+|\s+$//g;
    print join("\x1F", $key, $title, $doi, $url), "\n";
  }
' "$bib_file" > "$tmp_dir/bibliography.tsv"

while IFS=$'\x1F' read -r key title doi listed_url; do
  if is_active_key "$key"; then
    category="cited_in_current_manuscript"
    target_dir="$active_dir"
  else
    category="supporting_bibliography"
    target_dir="$supporting_dir"
  fi

  if [[ "$key" == "FabricPDC" || "$key" == "Hannun2023MLX" ]]; then
    append_manifest "$category" "$key" "$title" "$doi" "$listed_url" \
      "web_source_no_pdf" "" "" "Documentation or software source; no paper PDF expected."
    continue
  fi

  destination="$target_dir/${key}.pdf"
  source_url=$(manual_pdf_url "$key")
  if [[ -z "$source_url" && -n "$doi" ]]; then
    source_url=$(openalex_pdf_url "$doi")
  fi

  if [[ -f "$destination" ]] && head -c 5 "$destination" | grep -q '%PDF-'; then
    digest=$(shasum -a 256 "$destination" | awk '{print $1}')
    append_manifest "$category" "$key" "$title" "$doi" "$source_url" \
      "already_present" "${destination#$repo_dir/}" "$digest" "Previously downloaded PDF retained."
  elif [[ -n "$source_url" ]] && download_pdf "$source_url" "$destination"; then
    digest=$(shasum -a 256 "$destination" | awk '{print $1}')
    append_manifest "$category" "$key" "$title" "$doi" "$source_url" \
      "downloaded_open_access" "${destination#$repo_dir/}" "$digest" "Downloaded from a public open-access location."
  else
    landing_url="$source_url"
    if [[ -z "$landing_url" ]]; then
      landing_url="$listed_url"
    fi
    if [[ -z "$landing_url" && -n "$doi" ]]; then
      landing_url="https://doi.org/$doi"
    fi
    append_manifest "$category" "$key" "$title" "$doi" "$landing_url" \
      "not_downloaded" "" "" "No verified public PDF was saved automatically; the attempted public location or publisher page is retained for manual access."
  fi
done < "$tmp_dir/bibliography.tsv"

copy_local_pdf() {
  local key="$1"
  local title="$2"
  local source="$3"
  local destination="$benchmark_dir/${key}.pdf"

  if [[ -f "$source" ]] && head -c 5 "$source" | grep -q '%PDF-'; then
    cp -p "$source" "$destination"
    digest=$(shasum -a 256 "$destination" | awk '{print $1}')
    append_manifest "methodology_and_benchmark" "$key" "$title" "" "$source" \
      "copied_from_user_library" "${destination#$repo_dir/}" "$digest" "User-provided source preserved as a separate copy."
  else
    append_manifest "methodology_and_benchmark" "$key" "$title" "" "$source" \
      "not_downloaded" "" "" "Expected user-provided PDF was not found or was not a valid PDF."
  fi
}

copy_local_pdf "AVChain" \
  "AVChain: Trusted Sharing of Autonomous Vehicle Crash Incident Data using Interoperating HyperLedger Fabric Networks and IPFS" \
  "/Users/venkatrayudu/Desktop/Sengupta sir papers/3709158.pdf"
copy_local_pdf "ReAcct" \
  "ReAcct: Redaction Control for Interoperable Blockchains" \
  "/Users/venkatrayudu/Desktop/Sengupta sir papers/ReAcct_Redaction_Control_for_Interoperable_Blockchains.pdf"
copy_local_pdf "InterSnap" \
  "Auditable Ledger Snapshot for Non-Repudiable Cross-Blockchain Communication" \
  "/Users/venkatrayudu/Desktop/Sengupta sir papers/2511.16560v1.pdf"
copy_local_pdf "SecureBlockchainFL" \
  "Blockchain Based Secure Federated Learning With Local Differential Privacy and Incentivization" \
  "/Users/venkatrayudu/Desktop/Sengupta sir papers/Blockchain_Based_Secure_Federated_Learning_With_Local_Differential_Privacy_and_Incentivization.pdf"
copy_local_pdf "P2PBotnetCloseness" \
  "A Closeness Centrality Based P2P Botnet Detection Approach Using Deep Learning" \
  "/Users/venkatrayudu/Desktop/Sengupta sir papers/A_Closeness_Centrality_Based_P2P_Botnet_Detection_Approach_Using_Deep_Learning.pdf"

download_extra() {
  local key="$1"
  local title="$2"
  local doi="$3"
  local source_url="$4"
  local destination="$benchmark_dir/${key}.pdf"

  if [[ -f "$destination" ]] && head -c 5 "$destination" | grep -q '%PDF-'; then
    digest=$(shasum -a 256 "$destination" | awk '{print $1}')
    append_manifest "methodology_and_benchmark" "$key" "$title" "$doi" "$source_url" \
      "already_present" "${destination#$repo_dir/}" "$digest" "Previously downloaded PDF retained."
  elif download_pdf "$source_url" "$destination"; then
    digest=$(shasum -a 256 "$destination" | awk '{print $1}')
    append_manifest "methodology_and_benchmark" "$key" "$title" "$doi" "$source_url" \
      "downloaded_open_access" "${destination#$repo_dir/}" "$digest" "Downloaded from a public open-access location."
  else
    append_manifest "methodology_and_benchmark" "$key" "$title" "$doi" "$source_url" \
      "not_downloaded" "" "" "Public PDF download failed."
  fi
}

download_extra "Paillisse2019" \
  "Distributed Access Control with Blockchain" \
  "10.48550/arXiv.1901.03568" \
  "https://arxiv.org/pdf/1901.03568"
download_extra "Rouhani2019" \
  "Physical Access Control Management System Based on Permissioned Blockchain" \
  "10.1109/Cybermatics_2018.2018.00198" \
  "https://arxiv.org/pdf/1901.09873"

echo "Reference library created at: $library_dir"
echo "PDF count: $(find "$library_dir" -type f -name '*.pdf' | wc -l | tr -d ' ')"
echo "Manifest rows: $(($(wc -l < "$manifest") - 1))"
