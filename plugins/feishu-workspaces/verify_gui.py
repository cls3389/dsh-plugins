import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    response = page.goto("http://127.0.0.1:3080", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)
    groups = page.locator('[data-row-key^="workspace:"]').evaluate_all(
        "nodes => nodes.map(node => ({key: node.dataset.rowKey, text: node.innerText, buttons: [...node.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))}))"
    )
    feishu = page.locator('[data-row-key="workspace:80377b38-14c3-4f79-aef2-de5941c02a00"]')
    expanded_before = feishu.get_attribute("aria-expanded")
    feishu.click()
    page.wait_for_timeout(1000)
    expanded_after = feishu.get_attribute("aria-expanded")
    feishu_section = feishu.locator("xpath=..").inner_text()
    session_rows = page.locator('[data-row-key^="session:"]').evaluate_all("nodes => nodes.map(node => ({key: node.dataset.rowKey, text: node.innerText}))")
    body = page.locator("body").inner_text()
    page.screenshot(path="/work/gui-check.png", full_page=True)
    print(json.dumps({
        "status": response.status if response else None,
        "title": page.title(),
        "url": page.url,
        "groups": groups,
        "feishuSection": feishu_section,
        "expandedBefore": expanded_before,
        "expandedAfter": expanded_after,
        "sessionRows": session_rows,
        "hasFeishuTitle": "DSH Agent" in body and "cli_aa541ee21439dbcd" in body,
        "hasUngrouped": "未分组" in body,
        "errors": errors,
    }, ensure_ascii=False, indent=2))
    browser.close()
