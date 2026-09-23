#!/usr/bin/env python3
"""Generate the SEBA-XAI architecture diagram as SVG and draw.io XML.

Single source of truth: the NODES / EDGES tables below. Edit them and re-run:

    python3 docs/architecture/generate_architecture.py

Both outputs are written next to this script.
"""

from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1720, 1400

PALETTE = {
    "title":   ("#FFFFFF", "#FFFFFF", "#1B2A3A"),
    "band":    ("#FFFFFF", "#9AA7B4", "#1B2A3A"),
    "client":  ("#EEF1F4", "#325C8E", "#1B2A3A"),
    "backend": ("#E7EEF6", "#325C8E", "#1B2A3A"),
    "xai":     ("#E2F1F3", "#2E7D8A", "#123A40"),
    "fabric":  ("#E9F0E9", "#377E4E", "#14301F"),
    "chain":   ("#EFEAF5", "#6B4E8E", "#2A1D3A"),
    "vault":   ("#F5EFE6", "#8A6A2E", "#3A2C12"),
    "eval":    ("#F1F1F4", "#5A6472", "#232830"),
    "allow":   ("#DDEDE1", "#377E4E", "#14301F"),
    "deny":    ("#F5E2E2", "#A63A3A", "#3A1414"),
    "esc":     ("#F7EEDA", "#C08A2E", "#3A2C0E"),
}

# id, x, y, w, h, kind, title, body(list of lines), fontsize
NODES = [
    # ---------------------------------------------------------------- client
    ("band_client", 60, 70, 1600, 96, "band",
     "Presentation tier — role-aware browser (frontend/js, vanilla ES modules)", [], 14),
    ("ui_records", 90, 108, 380, 46, "client", "Records / cases view", [], 12),
    ("ui_access", 490, 108, 380, 46, "client", "Access request + decision", [], 12),
    ("ui_audit", 890, 108, 370, 46, "client", "Audit-trail reconstruction", [], 12),
    ("ui_explain", 1280, 108, 350, 46, "client", "Explanation panel", ["structured + plain language"], 12),

    # --------------------------------------------------------------- backend
    ("band_backend", 60, 200, 1600, 250, "band",
     "Application tier — Node.js / Express (backend/src). Holds no authority: every decision is read back from the ledger.", [], 14),
    ("mw_auth", 90, 248, 360, 60, "backend", "middleware/auth.js",
     ["session + identity binding"], 12),
    ("mw_log", 470, 248, 340, 60, "backend", "middleware/accessLogger.js", [], 12),
    ("routes", 830, 248, 800, 60, "backend", "routes/",
     ["auth · users · cases · records · access · audit · departments · explain"], 12),
    ("fab_gw", 90, 330, 340, 100, "backend", "fabric/gateway.js",
     ["per-user Fabric Gateway", "session (no shared admin identity)"], 12),
    ("fab_ca", 450, 330, 280, 100, "backend", "fabric/users.js · ca.js",
     ["X.509 enrolment,", "attribute issuance"], 12),
    ("vault_ad", 750, 330, 300, 100, "backend", "storage/vault.js",
     ["grant-bound retrieval,", "SHA-256 re-hash on read"], 12),
    ("xai_mod", 1070, 330, 560, 100, "xai", "llm/  —  explainable-AI module",
     ["explain.js  (prompt whitelist → validate → fallback)",
      "ollama.js  (local llama3.2:3b)   ·   template.js  (deterministic)"], 12),

    # ---------------------------------------------------------------- fabric
    ("band_fabric", 60, 512, 1600, 232, "band",
     "Hyperledger Fabric v2.5.16  ·  channel: crimechannel  ·  endorsement policy: 3 of 5 organizations", [], 14),
    ("orderer", 90, 562, 250, 156, "fabric", "Raft orderer",
     ["single node (prototype)", "BatchTimeout 2 s", "MaxMessageCount 10"], 12),
    ("org_pol", 380, 562, 246, 156, "fabric", "Police MSP",
     ["CA", "peer0.police", "CouchDB 3.4.2"], 12),
    ("org_for", 636, 562, 246, 156, "fabric", "Forensics MSP",
     ["CA", "peer0.forensics", "CouchDB 3.4.2"], 12),
    ("org_pro", 892, 562, 246, 156, "fabric", "Prosecution MSP",
     ["CA", "peer0.prosecution", "CouchDB 3.4.2"], 12),
    ("org_crt", 1148, 562, 246, 156, "fabric", "Court MSP",
     ["CA", "peer0.court", "CouchDB 3.4.2"], 12),
    ("org_aud", 1404, 562, 246, 156, "fabric", "Audit MSP",
     ["CA", "peer0.audit", "CouchDB 3.4.2"], 12),

    # ------------------------------------------------------------- chaincode
    ("band_chain", 60, 790, 1000, 186, "band",
     "Chaincode: crimerecords (JavaScript) — six contracts", [], 14),
    ("cc_gov", 90, 838, 300, 56, "chain", "governanceContract", [], 12),
    ("cc_usr", 410, 838, 300, 56, "chain", "userContract", [], 12),
    ("cc_rec", 730, 838, 300, 56, "chain", "recordContract", [], 12),
    ("cc_acc", 90, 906, 300, 56, "chain", "accessContract", [], 12),
    ("cc_aud", 410, 906, 300, 56, "chain", "auditContract", [], 12),
    ("cc_pol", 730, 906, 300, 56, "chain", "policyContract", [], 12),
    ("engine", 1090, 790, 570, 186, "chain", "policy/policyEngine.js  +  policyV1.js",
     ["Deterministic ordered rule list. Every required endorser",
      "re-executes it and must reach the same decision and the",
      "same explanation hash, or endorsement fails (Eq. 5).",
      "Non-determinism here would break consensus — this is why",
      "no learned model sits in the decision path."], 12),

    # ----------------------------------------------------------- rule ladder
    ("band_rules", 60, 1012, 760, 258, "band",
     "Rule ladder — first terminal rule decides (policy v1)", [], 14),
    ("r1", 82, 1058, 716, 22, "deny",   "1  credential not active  →  CRED_NOT_ACTIVE", [], 11),
    ("r2", 82, 1084, 716, 22, "deny",   "2  purpose missing / undeclared  →  INVALID_PURPOSE", [], 11),
    ("r3", 82, 1110, 716, 22, "deny",   "3  RBAC matrix  →  RBAC_NO_PERMISSION   ·   3b  AUDIT_METADATA_ONLY", [], 11),
    ("r4", 82, 1136, 716, 22, "esc",    "4  sealed record (non-Court)  →  SEALED_RECORD", [], 11),
    ("r5", 82, 1162, 716, 22, "deny",   "5  juvenile flag  →  JUVENILE_PROTECTED   ·   5b  VICTIM_DATA_NOT_NECESSARY", [], 11),
    ("r6", 82, 1188, 716, 22, "esc",    "6  cross-jurisdiction  →  CROSS_JURISDICTION  (allow if emergency + token)", [], 11),
    ("r7", 82, 1214, 716, 22, "deny",   "7  case assignment  →  NOT_ASSIGNED", [], 11),
    ("r8", 82, 1240, 716, 22, "esc",    "8  clearance < sensitivity  →  INSUFFICIENT_CLEARANCE", [], 11),

    # ------------------------------------------------------ explanation + AI
    ("artifact", 850, 1012, 380, 258, "chain", "Explanation artifact  E  (Eq. 4)",
     ["decision        allow | deny | escalate",
      "reasonCode      e.g. NOT_ASSIGNED",
      "decisiveAttrs   attributes the rule read",
      "counterfactual  what would change it",
      "policyVersion   crime-policy-v1",
      "",
      "h_E = SHA-256(canon(E))",
      "h_D = SHA-256(canon(record \\ h_D))",
      "",
      "Committed on-ledger. This artifact —",
      "not generated prose — is authoritative."], 11),
    ("pipeline", 1260, 1012, 400, 258, "xai", "XAI rendering + validation",
     ["1  read committed decision from ledger",
      "2  prompt from field whitelist only",
      "3  local llama3.2:3b generates prose",
      "4  validate against decisiveAttributes:",
      "     · contradicts ledger outcome",
      "     · calls an escalation final",
      "     · blames an attribute not decisive",
      "     · invents record / case identifiers",
      "5  fail → deterministic template",
      "6  UI badges the source + rejection",
      "",
      "Measured: 0.5 fallback rate (n = 6)."], 11),

    # ----------------------------------------------------------- vault + eval
    ("vault", 60, 1300, 760, 76, "vault", "Agency vault — off-chain, permission-restricted (never replicated to peers)",
     ["Ledger stores metadata + vault:// reference + content hash. Release requires an identity-bound grant;",
      "the retrieved payload is re-hashed and compared with the ledger commitment before it reaches the user."], 11),
    ("eval", 850, 1300, 810, 76, "eval", "Evaluation harness (measurement only — not part of the running system)",
     ["Hyperledger Caliper 0.7.1 — five latency axes, 27 plotted points, 3,114 transactions, 0 failed.",
      "Prometheus scrapes orderer + five peer metrics endpoints during runs."], 11),
]

# source, target, label, dashed, route
#   "v"   src bottom-centre -> dst top-centre (via mid-y corridor)
#   "h"   src right-centre  -> dst left-centre
#   "R"   out right, along the right margin, in through dst right edge
#   "L"   out left,  along the left  margin, in through dst left  edge
#   "C"   out right, up the corridor between the rule ladder and the artifact
EDGES = [
    ("ui_access",   "routes",      "signed request",                         False, "v"),
    ("routes",      "fab_gw",      "",                                       False, "v"),
    ("fab_gw",      "band_fabric", "submit / evaluate  (per-user identity)",  False, "v"),
    ("band_fabric", "band_chain",  "endorse · order · validate · commit", False, "v"),
    ("cc_pol",      "engine",      "",                                       False, "h"),
    ("engine",      "band_rules",  "first terminal rule",                    False, "v"),
    ("engine",      "artifact",    "emits D + E",                            False, "v"),
    ("artifact",    "pipeline",    "read back",                              True,  "h"),
    ("pipeline",    "ui_explain",  "rendered text + provenance badge",       True,  "R"),
    ("vault_ad",    "vault",       "grant-bound read",                       False, "L"),
    ("vault",       "band_chain",  "SHA-256 match vs ledger commitment",     True,  "C"),
]

RIGHT_MARGIN = 1694
LEFT_MARGIN = 34
MID_CORRIDOR = 835

BOUNDARY_Y = 494
BOUNDARY_TEXT = ("Trust boundary — below this line state is endorsed by three of five organizations; "
                 "above it, no single component is authoritative")

# --------------------------------------------------------------------- SVG

def node_by_id(nid):
    for n in NODES:
        if n[0] == nid:
            return n
    raise KeyError(nid)


def anchor(nid):
    _, x, y, w, h, *_ = node_by_id(nid)
    return (x + w / 2, y + h / 2, x, y, w, h)


def svg_text(x, y, s, size, weight="normal", fill="#1B2A3A", anchor_="middle", family=None):
    fam = family or "Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{fam}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor_}">{escape(s)}</text>')


def build_svg():
    o = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
    o.append('''<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#4A5563"/>
  </marker>
  <marker id="arrowd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#7C8794"/>
  </marker>
</defs>''')
    o.append(f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>')

    o.append(svg_text(W / 2, 40, "SEBA-XAI — system architecture", 24, "bold"))
    o.append(svg_text(W / 2, 60, "On-chain contextual access control with verifiable explanations for inter-agency crime-record sharing",
                      13, "normal", "#5A6472"))

    # trust boundary
    o.append(f'<line x1="60" y1="{BOUNDARY_Y}" x2="{W-60}" y2="{BOUNDARY_Y}" stroke="#A63A3A" '
             f'stroke-width="2" stroke-dasharray="10 6"/>')
    o.append(svg_text(W / 2, BOUNDARY_Y - 8, BOUNDARY_TEXT, 11.5, "bold", "#A63A3A"))

    # edges first (behind boxes)
    def chip(cx, cy, t):
        w = len(t) * 6.0 + 10
        return (f'<rect x="{cx-w/2:.1f}" y="{cy-9:.1f}" width="{w:.1f}" height="17" rx="3" '
                f'fill="#FFFFFF" opacity="0.94"/>'
                + svg_text(cx, cy + 4, t, 10.5, "normal", "#4A5563"))

    for src, dst, label, dashed, route in EDGES:
        _, _, sx0, sy0, sw, sh = anchor(src)
        _, _, dx0, dy0, dw, dh = anchor(dst)
        stroke = "#7C8794" if dashed else "#4A5563"
        dash = ' stroke-dasharray="7 5"' if dashed else ""
        marker = "arrowd" if dashed else "arrow"

        if route == "v":
            sx, sy, dx, dy = sx0 + sw / 2, sy0 + sh, dx0 + dw / 2, dy0
            mid = (sy + dy) / 2
            pts = [(sx, sy), (sx, mid), (dx, mid), (dx, dy)]
            lx, ly = (sx + dx) / 2, mid
        elif route == "h":
            sx, sy, dx, dy = sx0 + sw, sy0 + sh / 2, dx0, dy0 + dh / 2
            mx = (sx + dx) / 2
            pts = [(sx, sy), (mx, sy), (mx, dy), (dx, dy)]
            lx, ly = mx, min(sy, dy) - 14
        elif route == "R":
            sx, sy, dx, dy = sx0 + sw, sy0 + sh / 2, dx0 + dw, dy0 + dh / 2
            pts = [(sx, sy), (RIGHT_MARGIN, sy), (RIGHT_MARGIN, dy), (dx, dy)]
            lx, ly = RIGHT_MARGIN - 170, (sy + dy) / 2
        elif route == "L":
            sx, sy, dx, dy = sx0, sy0 + sh / 2, dx0, dy0 + dh / 2
            pts = [(sx, sy), (LEFT_MARGIN, sy), (LEFT_MARGIN, dy), (dx, dy)]
            lx, ly = LEFT_MARGIN + 130, (sy + dy) / 2
        else:  # "C" — corridor between the rule ladder and the artifact
            sx, sy, dx, dy = sx0 + sw, sy0 + sh / 2, MID_CORRIDOR, dy0 + dh
            pts = [(sx, sy), (MID_CORRIDOR, sy), (MID_CORRIDOR, dy)]
            lx, ly = MID_CORRIDOR + 6, (sy + dy) / 2

        d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        o.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="1.7"{dash} '
                 f'marker-end="url(#{marker})" opacity="0.8"/>')
        if label:
            if route == "C":
                o.append(svg_text(lx, ly, label, 10.5, "normal", "#4A5563", "start"))
            else:
                o.append(chip(lx, ly, label))

    # nodes
    for nid, x, y, w, h, kind, title, body, fs in NODES:
        fill, stroke, fg = PALETTE[kind]
        is_band = kind == "band"
        sw = 2 if is_band else 1.3
        dash = ' stroke-dasharray="6 4"' if is_band else ""
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="{sw}"{dash} opacity="{0.35 if is_band else 1}"/>')
        if is_band:
            o.append(svg_text(x + w / 2, y + 20, title, fs, "bold", stroke))
            continue
        if body:
            o.append(svg_text(x + w / 2, y + 20, title, fs, "bold", fg))
            ly = y + 20 + fs + 4
            for line in body:
                o.append(svg_text(x + w / 2, ly, line, fs - 1, "normal", fg))
                ly += fs + 3
        else:
            o.append(svg_text(x + w / 2, y + h / 2 + fs / 3, title, fs, "bold", fg))

    o.append('</svg>')
    return "\n".join(o)


# ------------------------------------------------------------------ draw.io

DRAWIO_STYLE = {
    "band":    "rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#9AA7B4;dashed=1;verticalAlign=top;fontStyle=1;fontSize=14;fontColor=#1B2A3A;",
    "client":  "rounded=1;whiteSpace=wrap;html=1;fillColor=#EEF1F4;strokeColor=#325C8E;fontSize=12;fontColor=#1B2A3A;",
    "backend": "rounded=1;whiteSpace=wrap;html=1;fillColor=#E7EEF6;strokeColor=#325C8E;fontSize=12;fontColor=#1B2A3A;",
    "xai":     "rounded=1;whiteSpace=wrap;html=1;fillColor=#E2F1F3;strokeColor=#2E7D8A;fontSize=12;fontColor=#123A40;",
    "fabric":  "rounded=1;whiteSpace=wrap;html=1;fillColor=#E9F0E9;strokeColor=#377E4E;fontSize=12;fontColor=#14301F;",
    "chain":   "rounded=1;whiteSpace=wrap;html=1;fillColor=#EFEAF5;strokeColor=#6B4E8E;fontSize=12;fontColor=#2A1D3A;",
    "vault":   "rounded=1;whiteSpace=wrap;html=1;fillColor=#F5EFE6;strokeColor=#8A6A2E;fontSize=11;fontColor=#3A2C12;",
    "eval":    "rounded=1;whiteSpace=wrap;html=1;fillColor=#F1F1F4;strokeColor=#5A6472;fontSize=11;fontColor=#232830;",
    "allow":   "rounded=0;whiteSpace=wrap;html=1;fillColor=#DDEDE1;strokeColor=#377E4E;fontSize=11;align=left;spacingLeft=8;",
    "deny":    "rounded=0;whiteSpace=wrap;html=1;fillColor=#F5E2E2;strokeColor=#A63A3A;fontSize=11;align=left;spacingLeft=8;",
    "esc":     "rounded=0;whiteSpace=wrap;html=1;fillColor=#F7EEDA;strokeColor=#C08A2E;fontSize=11;align=left;spacingLeft=8;",
}


def build_drawio():
    cells = []
    for nid, x, y, w, h, kind, title, body, fs in NODES:
        raw = f"<b>{title}</b>" if (body or kind == "band") else title
        if body:
            raw += "<br/>" + "<br/>".join(body)
        # draw.io stores label HTML inside an XML attribute, so the markup
        # itself must be entity-escaped; draw.io decodes and renders it.
        label = escape(raw, {'"': "&quot;"})
        cells.append(
            f'        <mxCell id="{nid}" value="{label}" style="{DRAWIO_STYLE[kind]}" vertex="1" parent="1">\n'
            f'          <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>\n'
            f'        </mxCell>')

    cells.append(
        f'        <mxCell id="boundary" value="{escape(BOUNDARY_TEXT, {chr(34): "&quot;"})}" '
        f'style="text;html=1;align=center;fontSize=11;fontStyle=1;fontColor=#A63A3A;" vertex="1" parent="1">\n'
        f'          <mxGeometry x="60" y="{BOUNDARY_Y-24}" width="{W-120}" height="20" as="geometry"/>\n'
        f'        </mxCell>')
    cells.append(
        f'        <mxCell id="boundaryline" value="" '
        f'style="endArrow=none;html=1;strokeColor=#A63A3A;strokeWidth=2;dashed=1;" edge="1" parent="1">\n'
        f'          <mxGeometry relative="1" as="geometry">\n'
        f'            <mxPoint x="60" y="{BOUNDARY_Y}" as="sourcePoint"/>\n'
        f'            <mxPoint x="{W-60}" y="{BOUNDARY_Y}" as="targetPoint"/>\n'
        f'          </mxGeometry>\n'
        f'        </mxCell>')

    for i, (src, dst, label, dashed, _r) in enumerate(EDGES):
        style = ("edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor="
                 + ("#7C8794;dashed=1;" if dashed else "#4A5563;")
                 + "fontSize=10;")
        cells.append(
            f'        <mxCell id="e{i}" value="{escape(label, {chr(34): "&quot;"})}" style="{style}" edge="1" '
            f'parent="1" source="{src}" target="{dst}">\n'
            f'          <mxGeometry relative="1" as="geometry"/>\n'
            f'        </mxCell>')

    body = "\n".join(cells)
    return f'''<mxfile host="app.diagrams.net" type="device">
  <diagram name="SEBA-XAI architecture" id="seba-xai-arch">
    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1"
                  connect="1" arrows="1" fold="1" page="1" pageScale="1"
                  pageWidth="{W}" pageHeight="{H}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="titlecell" value="&lt;b&gt;SEBA-XAI — system architecture&lt;/b&gt;" style="text;html=1;align=center;fontSize=22;" vertex="1" parent="1">
          <mxGeometry x="60" y="18" width="{W-120}" height="34" as="geometry"/>
        </mxCell>
{body}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
'''


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    (here / "seba_xai_architecture.svg").write_text(build_svg(), encoding="utf-8")
    (here / "seba_xai_architecture.drawio").write_text(build_drawio(), encoding="utf-8")
    print("wrote seba_xai_architecture.svg and seba_xai_architecture.drawio")
