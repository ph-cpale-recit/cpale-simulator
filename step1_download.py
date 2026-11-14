import requests
import os

def download_syllabus():
    url = "https://www.prc.gov.ph/sites/default/files/2022-30%20Annexes%20Syllabi%20Effective%20October%202022.pdf"
    target = "docs/PRC_CPALE_Syllabi_2022.pdf"
    print(f"Downloading {url}...")
    r = requests.get(url, stream=True)
    if r.status_code == 200:
        with open(target, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        print("Download complete.")
    else:
        print(f"Failed to download: {r.status_code}")

if __name__ == "__main__":
    download_syllabus()
