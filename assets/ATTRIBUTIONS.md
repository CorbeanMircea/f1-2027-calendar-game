# Asset attributions

Last updated: 19 November 2026

Asset files are named after the event stem the website uses: the event id without the year
(for example `monaco-2027` and `monaco-2026` both use `monaco`). The 2027 Mexico event
(`mexico-2027`) shares the `mexico-city` files through an alias in `theme.js`.

## Circuit outlines (`assets/circuits/`)

### CC0 collection (21 files)

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

### Wikimedia Commons (3 files)

| File | Source | Licence | Credit and obligation |
|---|---|---|---|
| portugal.svg | https://commons.wikimedia.org/wiki/File:Aut%C3%B3dromo_de_Algarve.svg | CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/) | Author: Sentoan. Credit required, with a link to the licence and a statement of any modification. |
| turkey.svg | https://commons.wikimedia.org/wiki/File:Circuit_Istanbul.svg | Public domain (author Rumbin) | None. Source recorded here. |
| spain.svg | https://commons.wikimedia.org/wiki/File:Madring_Formula_1_Circuit.svg | CC0 1.0 (author Dave F63) | None. Source recorded here. |

Credit text for portugal.svg: "Autódromo de Algarve by Sentoan, licensed under CC BY 3.0
(https://creativecommons.org/licenses/by/3.0/). Modified: reduced to a single path, viewBox 0 0 500 500,
no fill, currentColor stroke."
TO DO: confirm that the modification statement matches what was done to the file, and show this credit
somewhere on the site (for example a small line in the footer).

## Hero photographs (`assets/hero/`)

24 photographs, one per circuit stem (the same stems as the circuit files).
Source: Unsplash, downloaded by the owner under "Free to use under the Unsplash License".
Licence: https://unsplash.com/license
The photographers and photo page URLs were not recorded when the files were added. The Unsplash licence does not
require credit, but recording them is good practice: fill in the table below when convenient.
Optimised from originals in `assets/hero-originals/` (not committed, git-ignored) with `node tools/optimize-hero.mjs`.

| File | Photographer | Photo page URL | Downloaded |
|---|---|---|---|
| (to be filled in, one row per file) | | | |