# bptf-crosslist

A Tampermonkey userscript for [next.backpack.tf](https://next.backpack.tf) that cross-lists your
Marketplace.TF items on backpack.tf, **one copy of each item**, in a few seconds instead of the site's
dialog.

## Why

backpack.tf's own "Create listing" dialog (source: Marketplace.TF) takes minutes to draw a large
inventory, caps how many items you can tick, and lists every copy you select. If you hold 300 of the same
case you usually want one listing for it, not 300.

## What it does

1. **Load and refresh**: fetches your unlisted Marketplace.TF items (10,000 per request) and your live
   backpack.tf listings. Loading the Marketplace.TF inventory is also what makes backpack.tf drop
   cross-listings whose item sold or was delisted, so run it once a day.
2. Plans one listing per item name you have not cross-listed yet, using the cheapest copy. Names matching
   your skip words (e.g. `Refined Metal, Decal Tool`) and items under your minimum price (USD) are left
   out. A description you type goes on every listing (200 characters max).
3. Shows how many it will list and the most expensive 15. **Nothing is listed until you press
   "List N items".**
4. Posts them in batches of 100 and reports any that failed with backpack.tf's reason.

The price is the one you set on Marketplace.TF; backpack.tf uses that for cross-listings. When a listed
copy sells, the next run lists your next copy of that item.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`bptf-crosslist.user.js`](bptf-crosslist.user.js) (Raw) and press Install.
3. Sign in on next.backpack.tf. The panel appears bottom right.

You must be a verified Marketplace.TF seller with your inventory linked on backpack.tf.

## How it works (the endpoints)

All calls go through the page's own API client (`window.$nuxt.$client.http`: base `/cors`, your session's
Bearer token), so the script never sees or stores credentials.

| Call | Purpose |
| --- | --- |
| `GET /_account/getListableItems?source=marketplaceTf&limit=10000&offset=N` | Unlisted Marketplace.TF items, each with `marketplaceTfListing` (your price). Also prunes sold cross-listings. |
| `GET /_classifieds/userListings?limit=&skip=` | Your live listings, `{results, cursor:{total}}`. |
| `POST /_classifieds/userListings/batch` | Up to 100 rows `{id, intent:"sell", source:"marketplaceTf", currencies:{}, details}`. Answer: one row each, `{result}` or `{error:{message}}`. |
| `GET /api/classifieds/limits` | Your listing slots (not needed by the script). |

These are backpack.tf's internal endpoints, read from its front-end; they can change without notice.

## License

MIT
