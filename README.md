# SG MTG Price Finder

A tiny local web app that searches Singapore MTG store product APIs and sorts available listings by lowest SGD price.

## Stores in this first pass

- Hideout: https://hideoutcg.com/
- Games Haven: https://www.gameshaventcg.com/
- MTG Asia: https://www.mtg-asia.com/
- Grey Ogre: https://www.greyogregames.com/
- Mox & Lotus: https://www.moxandlotus.sg/
- One MTG: https://onemtg.com.sg/
- Dueller's Point: https://www.duellerspoint.com/

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

If you have Node installed, this also works:

```powershell
node server.js
```

Then open:

```text
http://localhost:3000
```

## Notes

- Shopify stores use their search suggest endpoint plus product detail JSON for available condition pricing.
- Mox & Lotus and Dueller's Point use custom search adapters.
- Results show the cheapest available copy per store, ignoring condition.
- You can paste a small decklist such as `4 Lightning Bolt` / `1 Sol Ring`; duplicate lines are combined.
- Batch searches include a "Cheapest Split Cart" grouped by store. It is a shopping plan with direct listing links, not automatic cart checkout yet.
- Store prices do not include shipping, pickup cost, membership discounts, or stock quantity guarantees for stores that hide exact quantity.
