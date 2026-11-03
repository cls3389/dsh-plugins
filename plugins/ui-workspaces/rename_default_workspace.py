import json
from playwright.sync_api import sync_playwright

WORKSPACE_ID = "1f069c27-f051-4281-b0d3-d5e3d0ab720c"
NEW_NAME = "DSH 管理"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:3080", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)
    row = page.locator(f'[data-row-key="workspace:{WORKSPACE_ID}"]')
    row.hover()
    page.get_by_role("button", name="Workspace actions for 默认", exact=True).click()
    page.get_by_role("menuitem", name="Rename", exact=True).click()
    dialog = page.get_by_role("dialog")
    field = dialog.locator("input").first
    field.fill(NEW_NAME)
    dialog.get_by_role("button", name="Rename", exact=True).click()
    page.wait_for_timeout(2000)
    print(json.dumps({
        "workspace": row.inner_text(),
        "renamed": row.inner_text() == NEW_NAME,
        "errors": page.locator('[role="alert"]').all_inner_texts(),
    }, ensure_ascii=False))
    browser.close()
