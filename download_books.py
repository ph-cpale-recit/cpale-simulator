import os
import requests

downloads = [
    ("https://assets.openstax.org/oscms-prodcms/media/documents/PrinciplesofAccounting-Volume1-OP.pdf", "Reference_Books/FAR/Undergrad_Textbooks/OpenStax_Principles_Accounting_Vol1.pdf"),
    ("https://assets.openstax.org/oscms-prodcms/media/documents/PrinciplesofAccounting-Volume2-OP.pdf", "Reference_Books/MS/Undergrad_Textbooks/OpenStax_Principles_Accounting_Vol2.pdf"),
    ("https://assets.openstax.org/oscms-prodcms/media/documents/PrinciplesofFinance-WEB.pdf", "Reference_Books/MS/Undergrad_Textbooks/OpenStax_Principles_Finance.pdf"),
    ("https://assets.openstax.org/oscms-prodcms/media/documents/Economics3e-WEB.pdf", "Reference_Books/MS/Undergrad_Textbooks/OpenStax_Principles_Economics_3e.pdf"),
]

for url, path in downloads:
    try:
        print(f"Downloading {url}...")
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(r.content)
        print(f"Saved to {path}")
    except Exception as e:
        print(f"Failed {url}: {e}")
