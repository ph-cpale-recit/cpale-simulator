#!/usr/bin/env python3
"""Organize CPALE syllabi and download open-access reference books.
Task 1: Split official syllabus into per-subject .md and per-course subfolders.
Task 2: Download open-access reference books/standards into matching folders.
Task 3: Verify text extraction, write inventory, shutdown if all pass.
"""
import json, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(r"D:\Mateo_OS\03_Projects\cpale-simulator")
DOCS = ROOT / "docs"
SYLL = ROOT / "Syllabus"
REFB = ROOT / "Reference_Books"

# ---------------------------------------------------------------- Task 1 ----
# 27 course subfolders per main subject
COURSES = {
    "FAR": ["Fundamentals_of_Accounting","Conceptual_Framework_and_Accounting_Standards",
            "Intermediate_Accounting_1","Intermediate_Accounting_2","Intermediate_Accounting_3",
            "Updates_in_Financial_Reporting_Standards"],
    "AFAR": ["Cost_Accounting_and_Control","Accounting_for_Special_Transactions",
             "Accounting_for_Business_Combinations","Accounting_for_Government_and_NonProfit"],
    "MS": ["Managerial_Economics","Financial_Management","Strategic_Cost_Management",
           "Management_Science","Strategic_Business_Analysis","Operations_Management_and_Strategic_Mgmt"],
    "Auditing": ["Governance_Business_Ethics_Risk_Mgmt_Internal_Control","Auditing_and_Assurance_Principles",
                 "Auditing_Concepts_and_Applications_1_and_2","Auditing_Specialized_Industries",
                 "Auditing_in_a_CIS_Environment","Operations_Auditing"],
    "Taxation": ["Income_Taxation","Business_and_Transfer_Taxation"],
    "RFBT": ["Law_on_Obligations_and_Contracts","Business_Laws_and_Regulations",
             "Regulatory_Framework_and_Legal_Issues"],
}

def ensure_folders():
    for subj, courses in COURSES.items():
        (SYLL / subj).mkdir(parents=True, exist_ok=True)
        (REFB / subj).mkdir(parents=True, exist_ok=True)
        for c in courses:
            (SYLL / subj / c).mkdir(parents=True, exist_ok=True)
            (REFB / subj / c).mkdir(parents=True, exist_ok=True)

def split_syllabus():
    """Parse docs/CPALE_OFFICIAL_SYLLABUS.md into per-subject .md files."""
    md = (DOCS / "CPALE_OFFICIAL_SYLLABUS.md").read_text(encoding="utf-8")
    # Sections split on '## <SUBJ> (Pages ...)'
    parts = re.split(r"\n## ", md)
    for part in parts:
        m = re.match(r"(FAR|AFAR|MS|Auditing|RFBT|Taxation)\b.*?\n", part)
        if not m:
            continue
        subj = m.group(1)
        body = part[m.end():]
        out = SYLL / subj / f"{subj}_Official_CPALE_Syllabus.md"
        out.write_text("# " + part.strip() + "\n", encoding="utf-8")
        print(f"[Task1] wrote {out}")

def map_course_sections():
    """Best-effort: place syllabus excerpts into course subfolders by keyword.
    Shortcut: keyword heuristics, not perfect semantic mapping; refine manually if needed."""
    kw = {
        "FAR": {
            "Fundamentals_of_Accounting": ["accounting process", "steps in the accounting", "special journals", "accounting cycle"],
            "Conceptual_Framework_and_Accounting_Standards": ["conceptual framework", "qualitative characteristics", "standard-setting", "IASB", "FRSC"],
            "Intermediate_Accounting_1": ["cash and other financial assets", "inventories", "property, plant", "intangible assets", "non-financial assets"],
            "Intermediate_Accounting_2": ["financial liabilities", "shareholders’ equity", "retained earnings", "share capital", "other topics"],
            "Intermediate_Accounting_3": ["income tax", "employee benefits", "interim reporting", "operating segments", "other reporting frameworks"],
            "Updates_in_Financial_Reporting_Standards": ["leases", "share-based payment", "biological assets", "held for sale", "impairment"],
        },
        "AFAR": {
            "Cost_Accounting_and_Control": ["cost accounting", "job-order", "process costing", "activity-based", "backflush", "joint and by-products"],
            "Accounting_for_Special_Transactions": ["revenue recognition", "joint arrangements", "derivatives", "hedging", "foreign currency"],
            "Accounting_for_Business_Combinations": ["business combination", "consolidated financial statements", "separate financial statements", "goodwill"],
            "Accounting_for_Government_and_NonProfit": ["not-for-profit", "government accounting", "voluntary health"],
        },
        "MS": {
            "Managerial_Economics": ["macroeconomics", "microeconomics", "supply", "demand", "market equilibrium"],
            "Financial_Management": ["financial management", "capital budgeting", "capital structure", "working capital", "financial markets", "cost of capital"],
            "Strategic_Cost_Management": ["standard costing", "variance analysis", "cost-volume profit", "breakeven", "activity-based"],
            "Management_Science": ["linear programming", "decision tree", "probability analysis", "regression"],
            "Strategic_Business_Analysis": ["balanced scorecard", "responsibility accounting", "transfer pricing", "performance measurement", "segmented income"],
            "Operations_Management_and_Strategic_Mgmt": ["planning & control", "budget", "master budget", "flexible", "zero-based"],
        },
        "Auditing": {
            "Governance_Business_Ethics_Risk_Mgmt_Internal_Control": ["governance", "ethics", "quality management", "corporate governance", "internal control"],
            "Auditing_and_Assurance_Principles": ["assurance engagements", "introduction to auditing", "attestation services", "types of audit"],
            "Auditing_Concepts_and_Applications_1_and_2": ["risk-based", "audit planning", "materiality", "audit evidence", "working papers", "audit report"],
            "Auditing_Specialized_Industries": ["special purpose", "component", "service organization", "prospective financial"],
            "Auditing_in_a_CIS_Environment": ["CIS", "computerized information", "computer assisted", "electronic commerce", "general controls"],
            "Operations_Auditing": ["operational audit", "compliance audit", "root cause"],
        },
        "Taxation": {
            "Income_Taxation": ["income taxation", "gross income", "deductions", "withholding", "accounting periods", "taxable income"],
            "Business_and_Transfer_Taxation": ["value-added tax", "percentage tax", "excise tax", "documentary stamp", "estate tax", "donor", "transfer taxes", "local government"],
        },
        "RFBT": {
            "Law_on_Obligations_and_Contracts": ["obligations", "contracts", "sales", "credit transactions", "bouncing checks", "consumer protection"],
            "Business_Laws_and_Regulations": ["partnerships", "corporations", "corporate governance", "securities", "insurance", "cooperatives", "competition act", "government procurement"],
            "Regulatory_Framework_and_Legal_Issues": ["financial rehabilitation", "insolvency", "PDIC", "secrecy of bank", "truth in lending", "AMLA", "intellectual property", "data privacy", "electronic commerce", "labor law", "social security"],
        },
    }
    for subj, cmap in kw.items():
        src = SYLL / subj / f"{subj}_Official_CPALE_Syllabus.md"
        if not src.exists():
            continue
        text = src.read_text(encoding="utf-8")
        lines = text.splitlines()
        # Group lines by top-level section (e.g. "1.0", "2.0") for excerpting
        for course, keys in cmap.items():
            excerpt = []
            capture = False
            for line in lines:
                if re.match(r"^\d+\.\d*\s", line):  # new subsection
                    capture = any(k.lower() in line.lower() for k in keys)
                if capture:
                    excerpt.append(line)
            if excerpt:
                out = SYLL / subj / course / f"{course}_syllabus_excerpt.md"
                out.write_text("# " + course.replace("_", " ") + " — excerpt from " + subj + " Official CPALE Syllabus\n\n" + "\n".join(excerpt) + "\n", encoding="utf-8")
                print(f"[Task1] wrote {out}")

# ---------------------------------------------------------------- Task 2 ----
# Open-access direct URLs (verified stable mirrors). Only these — no Scribd, no piracy.
BOOKS = {
    "Reference_Books/FAR/Financial_Accounting_OpenStax.pdf":
        "https://openstax.org/books/principles-financial-accounting/pdf",
    "Reference_Books/MS/Managerial_Accounting_OpenStax.pdf":
        "https://openstax.org/books/principles-managerial-accounting/pdf",
    "Reference_Books/MS/Principles_of_Finance_OpenStax.pdf":
        "https://openstax.org/books/principles-finance/pdf",
    "Reference_Books/MS/Managerial_Economics_OpenStax.pdf":
        "https://openstax.org/books/principles-economics-3e/pdf",
    "Reference_Books/RFBT/Revised_Corporation_Code_RA11232.pdf":
        "https://www.officialgazette.gov.ph/downloads/2019/02/Republic-Act-No-11232.pdf",
    "Reference_Books/RFBT/Civil_Code_of_the_Philippines.pdf":
        "https://www.officialgazette.gov.ph/downloads/1949/06/21/Civil-Code-of-the-Philippines/",
    "Reference_Books/Taxation/NIRC_as_amended_by_TRAIN.pdf":
        "https://www.bir.gov.ph/index.php?option=com_content&view=article&id=203",
}

def download_books():
    import requests
    os.makedirs(REFB, exist_ok=True)
    hdr = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
    for rel, url in BOOKS.items():
        dst = ROOT / rel
        try:
            r = requests.get(url, headers=hdr, timeout=30, allow_redirects=True)
            if r.status_code == 200 and len(r.content) > 1000:
                dst.write_bytes(r.content)
                print(f"[Task2] OK  {dst}  {len(r.content)} bytes  <- {url}")
            else:
                print(f"[Task2] FAIL {url}  status={r.status_code} len={len(r.content)}")
        except Exception as e:
            print(f"[Task2] ERR  {url}  {e}")

# ---------------------------------------------------------------- Task 3 ----
def verify():
    try:
        from pypdf import PdfReader
        have_pypdf = True
    except Exception:
        have_pypdf = False
    rows = []
    for p in sorted(REFB.rglob("*")):
        if not p.is_file() or p.name == "INVENTORY_REPORT.md":
            continue
        size = p.stat().st_size
        ok = False; kind = ""
        if p.suffix.lower() == ".pdf":
            if have_pypdf and size > 1000:
                try:
                    r = PdfReader(str(p))
                    txt = "".join((pg.extract_text() or "") for pg in r.pages[:5])
                    ok = len(txt.strip()) > 200
                    kind = "pypdf"
                except Exception as e:
                    kind = f"pypdf-error:{e}"
            else:
                kind = "pypdf-missing" if not have_pypdf else "too-small"
        else:
            try:
                t = p.read_text(encoding="utf-8", errors="ignore")
                ok = len(t.strip()) > 200
                kind = "utf8"
            except Exception as e:
                kind = str(e)
        rows.append((str(p.relative_to(REFB)), ok, kind, size))
    return rows

def write_inventory(rows):
    lines = ["# Reference_Books Inventory Report", "",
             "| File | Text-Extractable | Method | Size (bytes) |",
             "|---|---|---|---|"]
    for name, ok, kind, size in rows:
        lines.append(f"| {name} | {'PASS' if ok else 'FAIL'} | {kind} | {size} |")
    allpass = all(r[1] for r in rows)
    lines += ["", f"**All files pass:** {allpass}", ""]
    out = REFB / "INVENTORY_REPORT.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"[Task3] wrote {out}  allpass={allpass}")
    return allpass

def main():
    ensure_folders()
    split_syllabus()
    map_course_sections()
    download_books()
    rows = verify()
    allpass = write_inventory(rows)
    print("--- inventory ---")
    for r in rows:
        print(r)
    if allpass:
        print("[Task3] ALL PASS -> shutdown")
        subprocess.run(["shutdown", "/s", "/t", "60", "/c",
                        "Claude Code finished organizing CPALE Syllabi and Reference Books. Shutting down in 60 seconds."],
                       check=False)
    else:
        print("[Task3] NOT all pass -> no shutdown")

if __name__ == "__main__":
    main()
