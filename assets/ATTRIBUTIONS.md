# Asset attributions

Last updated: 27 October 2026

Asset files are named after the event stem the website uses: the event id without the year
(for example `monaco-2027` and `monaco-2026` both use `monaco`). The 2027 Mexico event
(`mexico-2027`) shares the `mexico-city` files through an alias in `theme.js`.

## Circuit outlines (`assets/circuits/`)

Source: MasterPlay007, "F1-Track-Layouts-SVG"
https://github.com/MasterPlay007/F1-Track-Layouts-SVG
Licence: CC0 1.0 Universal (public domain dedication), as declared by the repository.

The path coordinates are unchanged. Each file was normalised to a single `<path>` with
`viewBox="0 0 500 500"`, and `fill="none"` and a `currentColor` stroke were added.

| File | Source file |
|---|---|
| bahrain.svg | bahrain.svg |
| saudi-arabia.svg | jeddah.svg |
| australia.svg | albert_park.svg |
| japan.svg | suzuka.svg |
| china.svg | shanghai.svg |
| miami.svg | miami.svg |
| canada.svg | villeneuve.svg |
| monaco.svg | monaco.svg |
| great-britain.svg | silverstone.svg |
| austria.svg | red_bull_ring.svg |
| belgium.svg | spa.svg |
| hungary.svg | hungaroring.svg |
| italy.svg | monza.svg |
| azerbaijan.svg | baku.svg |
| singapore.svg | marina_bay.svg |
| united-states.svg | americas.svg |
| mexico-city.svg | rodriguez.svg |
| brazil.svg | interlagos.svg |
| las-vegas.svg | vegas.svg |
| qatar.svg | losail.svg |
| abu-dhabi.svg | yas_marina.svg |

### Circuits still to add

These are not in the CC0 collection and come from Wikimedia Commons. Check the licence on
the file page when downloading.

| File to create | Source | Licence | Obligation |
|---|---|---|---|
| portugal.svg | https://commons.wikimedia.org/wiki/File:Aut%C3%B3dromo_de_Algarve.svg | CC BY 3.0 | Credit the author (Sentoan), link the licence, state any modification. Add the credit here when the file is added. |
| turkey.svg | https://commons.wikimedia.org/wiki/File:Circuit_Istanbul.svg | Public domain (author Rumbin) | None; record the source here. |
| spain.svg | https://commons.wikimedia.org/wiki/File:Madring_Formula_1_Circuit.svg | CC0 1.0 (author Dave F63) | None; record the source here. |

Each must contain exactly one circuit `<path>` and a `viewBox`. Until then the homepage
draws a generated decorative racing line for these three races.

## Hero photographs (`assets/hero/`)

No photographs have been added yet. Use only photos that the Unsplash page marks
"Free to use under the Unsplash License". Do not use Unsplash+ photos.
Licence: https://unsplash.com/license

Record every photo below when it is added.

| File | Photographer | Photo page URL | Downloaded |
|---|---|---|---|
| (none yet) | | | |

Optimise originals with `node tools/optimize-hero.mjs` before committing them.
