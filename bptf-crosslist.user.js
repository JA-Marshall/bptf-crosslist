// ==UserScript==
// @name         backpack.tf: cross-list one of each from Marketplace.TF
// @namespace    https://github.com/JA-Marshall/bptf-crosslist
// @version      1.3.0
// @description  On next.backpack.tf, one button loads your Marketplace.TF inventory (which also clears cross-listings that sold or were delisted), works out every item you have not cross-listed yet, one copy each, and lists them in batches of 100 after you confirm. Never runs on its own.
// @match        https://next.backpack.tf/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/JA-Marshall/bptf-crosslist/main/bptf-crosslist.user.js
// @updateURL    https://raw.githubusercontent.com/JA-Marshall/bptf-crosslist/main/bptf-crosslist.user.js
// ==/UserScript==

/*
 * backpack.tf's own "Create listing" dialog, minus the dialog (read from its code and its calls, 2026-11):
 *  - GET  /cors/_account/getListableItems?source=marketplaceTf&limit=10000&offset=N  your Marketplace.TF items that
 *    are not listed yet, 10,000 a page (two pages for ~16.5k items, ~7 s each). Loading it is also what makes
 *    backpack.tf drop cross-listings whose item sold or was delisted on Marketplace.TF.
 *  - GET  /cors/_classifieds/userListings?limit=&skip=  your live listings (to skip names already cross-listed).
 *  - POST /cors/_classifieds/userListings/batch  [{id, intent:"sell", source:"marketplaceTf", currencies:{}, details}]
 *    at most 100 rows a call; the answer is one row each, {result} when posted or {error:{message}} when not.
 * Auth is the site's own Bearer token, so the calls go through the page's own client (window.$nuxt.$client.http).
 * The price is the one set on Marketplace.TF; backpack.tf ignores currencies for a Marketplace.TF cross-listing.
 * The 4 minutes of the site's dialog is it drawing 16k tiles, not the fetch.
 * The description box goes on every listing as its details (200 characters, kept between runs; first filled from the
 * default sell comment set on backpack.tf).
 * The minimum price box leaves out items whose cheapest copy is under it (USD, the Marketplace.TF price).
 * Rate limits (429) are waited out and the same batch is sent again; only an item backpack.tf refuses is reported.
 * One copy per item name: the cheapest copy on Marketplace.TF. A name already cross-listed is skipped, so the next
 * run after a sale lists the next copy. Nothing is listed until you press the confirm button.
 */
(function () {
    'use strict';
    const W = unsafeWindow;
    const PAGE = 10000;
    const BATCH = 100;
    const GAP_MS = 5000; // between batches; faster than this and backpack.tf answers 429
    const MAX_TRIES = 8;
    const SKIP_KEY = 'skipWords';
    const LAST_KEY = 'lastRun';
    const DESC_KEY = 'description';
    const MIN_KEY = 'minPrice';
    const MAX_DESC = 200; // the site's own limit (maxDetailsLength)

    const http = () => W.$nuxt && W.$nuxt.$client && W.$nuxt.$client.http;
    const me = () => W.$nuxt && W.$nuxt.$auth && W.$nuxt.$auth.user;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const today = () => new Date().toISOString().slice(0, 10);

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;width:340px;max-height:70vh;overflow:auto;background:#1e2329;color:#e8e8e8;border:1px solid #54748b;border-radius:8px;padding:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5)';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b>Cross-list one of each</b><span data-x style="cursor:pointer;opacity:.7">–</span></div>
      <div data-body>
        <div data-last style="opacity:.8;margin-bottom:6px"></div>
        <label style="display:block;margin-bottom:6px">Skip names containing (comma separated)
          <input data-skip style="width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;padding:3px"></label>
        <label style="display:block;margin-bottom:6px">Only list items priced at least $ (Marketplace.TF price, blank = all)
          <input data-min type="number" min="0" step="0.01" style="width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;padding:3px"></label>
        <label style="display:block;margin-bottom:6px">Description on every listing (<span data-count></span>/200)
          <textarea data-desc maxlength="200" rows="3" style="width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;padding:3px;resize:vertical"></textarea></label>
        <button data-load style="width:100%;padding:6px;background:#54748b;color:#fff;border:0;border-radius:4px;cursor:pointer">Load and refresh</button>
        <div data-out style="margin-top:8px;white-space:pre-wrap"></div>
        <button data-go style="display:none;width:100%;margin-top:6px;padding:6px;background:#3a8f4b;color:#fff;border:0;border-radius:4px;cursor:pointer"></button>
      </div>`;
    const $ = (s) => box.querySelector(`[data-${s}]`);
    const out = (t) => { $('out').textContent = t; };
    const skipInput = $('skip');
    skipInput.value = GM_getValue(SKIP_KEY, '');
    skipInput.addEventListener('change', () => GM_setValue(SKIP_KEY, skipInput.value));
    const minInput = $('min');
    minInput.value = GM_getValue(MIN_KEY, '');
    minInput.addEventListener('change', () => GM_setValue(MIN_KEY, minInput.value));
    const descInput = $('desc');
    const showCount = () => { $('count').textContent = descInput.value.length; };
    descInput.value = GM_getValue(DESC_KEY, '');
    if (!descInput.value) { // first run: start from the default sell comment set on backpack.tf, once the page has it
        const fill = () => { const u = me(); if (u && u.preferences && u.preferences.defaultSellOrderComment && !descInput.value) { descInput.value = u.preferences.defaultSellOrderComment.slice(0, MAX_DESC); showCount(); } };
        fill(); setTimeout(fill, 3000);
    }
    descInput.addEventListener('input', () => { GM_setValue(DESC_KEY, descInput.value); showCount(); });
    showCount();
    const showLast = () => {
        const last = GM_getValue(LAST_KEY, '');
        $('last').textContent = last ? `Last run: ${last}${last.startsWith(today()) ? '' : ' (not today)'}` : 'Never run from here.';
        $('last').style.color = last.startsWith(today()) ? '' : '#f0b54a';
    };
    $('x').addEventListener('click', () => { const b = $('body'); b.style.display = b.style.display === 'none' ? '' : 'none'; });
    showLast();
    document.body.appendChild(box);

    let plan = [];

    async function loadListable() {
        const items = [];
        for (let offset = 0; ; offset += PAGE) {
            out(`Loading Marketplace.TF inventory${offset ? ` (page ${offset / PAGE + 1})` : ''}… also clears sold cross-listings.`);
            const r = await http().get('/_account/getListableItems', { params: { source: 'marketplaceTf', limit: PAGE, offset }, timeout: 0 });
            items.push(...r.data);
            if (r.data.length < PAGE) break;
        }
        return items;
    }

    async function listedNames() {
        const names = new Set();
        for (let skip = 0; ;) {
            const r = await http().get('/_classifieds/userListings', { params: { limit: 1000, skip } });
            const rows = r.data.results || [];
            const total = (r.data.cursor && r.data.cursor.total) || 0;
            for (const l of rows) {
                const n = l.item && (l.item.name || l.item.marketName);
                if (!n) throw new Error('a live listing has no item name; stopping so nothing gets listed twice');
                if (l.intent === 'sell' || l.intent === 0 || l.intent === undefined) names.add(n);
            }
            skip += rows.length;
            if (!rows.length || skip >= total) break;
        }
        return names;
    }

    $('load').addEventListener('click', async () => {
        if (!http() || !me()) return out('Sign in on backpack.tf first (the page client is not ready).');
        $('load').disabled = true; $('go').style.display = 'none'; plan = [];
        try {
            const items = await loadListable();
            out('Reading your live listings…');
            const listed = await listedNames();
            const skipWords = skipInput.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            const minPrice = parseFloat(minInput.value) || 0;
            const best = new Map();
            for (const i of items) {
                if (!i.tradable || listed.has(i.name)) continue;
                if (skipWords.some((w) => i.name.toLowerCase().includes(w))) continue;
                const price = i.marketplaceTfListing ? i.marketplaceTfListing.value : Infinity;
                const cur = best.get(i.name);
                if (!cur || price < cur.price) best.set(i.name, { id: i.id, name: i.name, price });
            }
            const all = [...best.values()];
            plan = all.filter((p) => p.price >= minPrice).sort((a, b) => b.price - a.price);
            const underMin = all.length - plan.length;
            GM_setValue(LAST_KEY, `${today()} ${new Date().toTimeString().slice(0, 5)} (refresh)`);
            showLast();
            const sample = plan.slice(0, 15).map((p) => `$${p.price.toFixed(2)}  ${p.name}`).join('\n');
            out(`${items.length} unlisted Marketplace.TF items, ${listed.size} names already cross-listed.\n` +
                `${plan.length} new items to list, one copy each (cheapest copy, at your Marketplace.TF price)` +
                (underMin ? `; ${underMin} more under $${minPrice.toFixed(2)} left out.\n\n` : '.\n\n') +
                (plan.length ? `Top by price:\n${sample}${plan.length > 15 ? `\n…and ${plan.length - 15} more` : ''}` : 'Nothing new to list.'));
            if (plan.length) { $('go').textContent = `List ${plan.length} items`; $('go').style.display = ''; }
        } catch (e) {
            out(`Failed: ${e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message}`);
        } finally { $('load').disabled = false; }
    });

    $('go').addEventListener('click', async () => {
        if (!plan.length) return;
        $('go').disabled = true; $('load').disabled = true; descInput.disabled = true;
        const details = descInput.value.trim().slice(0, MAX_DESC);
        let ok = 0; const failed = [];
        try {
            for (let i = 0; i < plan.length; i += BATCH) {
                const chunk = plan.slice(i, i + BATCH);
                out(`Listing ${i + 1}–${i + chunk.length} of ${plan.length}… (${ok} posted so far)`);
                const body = chunk.map((p) => ({ id: p.id, intent: 'sell', source: 'marketplaceTf', currencies: {}, details }));
                for (let attempt = 1; ; attempt++) {
                    try {
                        const r = await http().post('/_classifieds/userListings/batch', body);
                        r.data.forEach((row, k) => {
                            if (row && Object.prototype.hasOwnProperty.call(row, 'result')) ok++;
                            else failed.push(`${chunk[k] ? chunk[k].name : '?'}: ${row && row.error ? row.error.message : 'no answer'}`);
                        });
                        break;
                    } catch (e) {
                        const status = e.response ? e.response.status : 0;
                        // rate limited (429) or a passing server error: wait and send the same batch again
                        if ((status === 429 || status >= 500 || !status) && attempt < MAX_TRIES) {
                            const after = Number(e.response && e.response.headers && e.response.headers['retry-after']);
                            const wait = after > 0 ? after * 1000 : Math.min(15000 * attempt, 120000);
                            out(`backpack.tf says slow down (${status || 'no answer'}); waiting ${Math.round(wait / 1000)} s, then batch ${i / BATCH + 1} again (try ${attempt + 1} of ${MAX_TRIES}). ${ok} posted so far.`);
                            await sleep(wait);
                            continue;
                        }
                        chunk.forEach((p) => failed.push(`${p.name}: ${status || e.message}`));
                        break;
                    }
                }
                await sleep(GAP_MS);
            }
        } finally {
            GM_setValue(LAST_KEY, `${today()} ${new Date().toTimeString().slice(0, 5)} (listed ${ok})`);
            showLast();
            out(`Done: ${ok} listed, ${failed.length} not.${failed.length ? `\n\n${failed.slice(0, 40).join('\n')}${failed.length > 40 ? `\n…and ${failed.length - 40} more` : ''}` : ''}`);
            plan = []; $('go').style.display = 'none'; $('go').disabled = false; $('load').disabled = false; descInput.disabled = false;
        }
    });
})();
