#!/usr/bin/env bash
# Registers the 100 officers once V7's 600-case test has started: that test uses
# only the model server, so no timed run is disturbed by the registrations.
cd "/Users/venkatrayudu/Workspace/XAI workspace/DIAS" || exit 1
R=experiments/runs/20261014_mac_mobile_setups
until grep -q "v7 quality: start" "$R/campaign.log"; do sleep 15; done
echo "$(date '+%F %T') registration: start" >> "$R/campaign.log"
node experiments/e2e/users100.js --register --out "$R/users-100-registration.json" > "$R/users-100-registration.log" 2>&1
echo "$(date '+%F %T') registration: exit $? ($(tail -1 "$R/users-100-registration.log"))" >> "$R/campaign.log"
