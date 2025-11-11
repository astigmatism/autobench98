# AutoBench98 Studio – OwnerKey Security Model

This document explains the current **OwnerKey** mechanism used in the Studio front end to control edit permissions, outlines what level of protection it provides, and includes helper scripts to generate editable URLs directly from the browser console.

---

## 1. Purpose

The OwnerKey model provides **local, client-side ownership** of a Studio layout without requiring a backend service.

It is designed to:
- Prevent **accidental edits** by others.
- Enable **shareable view-only links**.
- Keep the system **offline-capable** and fully self-contained.

It is **not** designed to provide strong authentication or access control.

---

## 2. How it works

### 🔹 Local storage identity

When you first open Studio, a unique UUID is generated and stored locally:

```
localStorage['ab98:studio:ownerKey'] = "<uuid>"
```

This value identifies **you (this browser)** as the layout owner. It never leaves your machine unless you explicitly share it in a URL.

---

### 🔹 Editable vs. View-only links

Studio recognizes two URL query parameters:

| Parameter | Description |
|------------|-------------|
| `layout` | Base64URL-encoded JSON layout snapshot. |
| `edit`   | Optional. The ownerKey of the browser that is allowed to edit. |

**Editable link example:**

```
/studio?layout=<encoded-layout>&edit=<ownerKey>
```

**View-only link example:**

```
/studio?layout=<encoded-layout>
```

When a page loads, Studio compares the `edit` token (if any) against the value of `localStorage['ab98:studio:ownerKey']`.

- If they match → edit mode is enabled (hamburger visible, modal Apply/Delete enabled).
- If not → view-only mode (no edit controls).

---

## 3. Security characteristics

| Property | Description |
|-----------|--------------|
| **Verification** | Performed entirely in the browser. |
| **Server involvement** | None – fully client-side. |
| **Strength** | Prevents accidental modification, not malicious tampering. |
| **Offline support** | Full – no network needed. |
| **Isolation** | Each browser/device has its own `ownerKey`. |
| **Rotating keys** | Delete `localStorage['ab98:studio:ownerKey']` to regenerate a new one. |

---

## 4. Generating an editable URL manually

Sometimes you may need to generate a fresh link that includes your `?edit=` token. The snippets below can be pasted into your browser’s JavaScript console.

### 🧩 Option 1 – Build an editable link from localStorage

```js
(() => {
    const OWNER_KEY_LS = 'ab98:studio:ownerKey';
    const LAYOUT_LS    = 'ab98:studio:layout';

    const ownerKey = localStorage.getItem(OWNER_KEY_LS);
    if (!ownerKey) throw new Error('No ownerKey found. Open Studio once to generate it.');

    const layoutJson = localStorage.getItem(LAYOUT_LS);
    if (!layoutJson) throw new Error('No saved layout found in localStorage.');

    const utf8 = encodeURIComponent(layoutJson).replace(/%([0-9A-F]{2})/g, (_, m) => String.fromCharCode(parseInt(m, 16)));
    const b64url = btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const url = `${location.origin}${location.pathname}?layout=${b64url}&edit=${ownerKey}`;
    console.log('Editable link:', url);

    (async () => {
        try { await navigator.clipboard.writeText(url); console.log('Copied to clipboard.'); }
        catch {}
    })();

    return url;
})();
```

### 🧩 Option 2 – Add your ownerKey to the current URL

If you’re already viewing a shared layout (`?layout=` present) and just want to add your local `?edit=` parameter:

```js
(() => {
    const OWNER_KEY_LS = 'ab98:studio:ownerKey';
    const ownerKey = localStorage.getItem(OWNER_KEY_LS);
    if (!ownerKey) throw new Error('No ownerKey found. Open Studio once to generate it.');

    const params = new URLSearchParams(location.search);
    const layout = params.get('layout');
    if (!layout) throw new Error('No ?layout= parameter in URL.');

    params.set('edit', ownerKey);
    const url = `${location.origin}${location.pathname}?${params.toString()}`;
    console.log('Editable link from current URL:', url);

    (async () => {
        try { await navigator.clipboard.writeText(url); console.log('Copied to clipboard.'); }
        catch {}
    })();

    return url;
})();
```

---

## 5. Limitations and recommendations

- The OwnerKey system is **not secure** against intentional forgery or inspection. Anyone with the key can edit.
- It is a **trust-based model**: useful for avoiding unintentional edits but not for multi-user access control.
- Do not share links containing your `?edit=` token unless you intend the recipient to have edit rights.

For stronger guarantees, a future version could integrate a lightweight backend for key verification or cryptographic signing.

---

_Last updated: November 2025_
