# P1-B research notes: nests and space (Pheidole megacephala, Xitun garden)

Checked: 2026-11-02. Research working notes, copied into the repo unchanged apart from this header. Downloads are not committed; the geometry arithmetic is `geometry-check.py` in this folder.

**Number classes** (CLAUDE.md §3): **文獻支持** means the value is from literature (with its limits); **一般生理學** means general insect or ectotherm physiology (and here also general soil physics, which is flagged as such); **遊戲假設** means a game assumption.
**Evidence grade** (repo convention, docs/research-design-2026-11.md): **a** = this species, **b** = another species (「非本種」), **c** = nothing found.
**Access**: full text / abstract / metadata only / search-snippet (search-snippet numbers must be re-checked before use).

---

## 0. Repo facts this work depends on

The facts below were read from the repo; nothing was changed.

### 0.1 Three spatial records disagree, and the design must keep all three
| Record | Where | Content |
|---|---|---|
| Legacy story map (read-only, Day1–14) | `saves/world-state.json#/world_map` | Origin is the "N00入口". Unit is cm, precision "敘事近似值非實測". Each place has a `bearing` word and an approximate `distance_cm` from the N00 entrance, with `coordinates_cm: null` for all. `route_edges` is a **star from N00** (N00–F01…F11 with `legacy_approx_distance_cm` 48/38/64/92/73/23/31/83/19/42/35, `verified_route_length_cm: null`) plus N00–U00 and U00–U01. N01 and N02 have bearing "未定" and distance null. |
| Engine topology (Day15+ world params) | `world/xitun-garden.json#/routes/topology/edges` | N00–F01, N00–F08, N00–F07, N00–F11, N00–U00, N00–U01, F01–F04, F04–F05, F08–F05, U01–F10. **There is no N00–F04 and no N00–F05 edge.** The engine has **N00–U01**, while the legacy record has **U00–U01**. |
| Movement lengths (v2-review.17) | `world/xitun-garden.json#/routes/edge_length_cm` | Only F01:N00=48, F07:N00=31, F08:N00=83 and F11:N00=35, with `path_tortuosity`=1. All other edges are unknown and use `route_edge_minutes`=25. The stated `extrapolation_limit` reads "直線距離，是實際路徑長度的下限；沒有量測、沒有座標". |

**Engine use** (`engine/activity.ts#edgeMinutes`): `minutes = len_cm·10·tortuosity / speed_mm_s / 60` when a length is recorded. If no length is recorded, the edge takes the legacy 25 min.

**Viewer use** (branch `…-web-mvp`, `cli/web-export.ts#layoutOf`, `web/src/model.ts#displayPositions`): the viewer maps the 8 compass words to 0/45/…/315°, then sets x = sin·d and y = cos·d (x east, y north, cm). Places without a bearing or distance go to an "unknown position" tray. Links are drawn as straight segments between the schematic points. The label shows `length_cm` or null.

### 0.2 Consistency checks on the schematic layout (computed by `scripts/geom.py`)
Schematic points: F01 (33.9, 33.9), F04 (0, 92), F05 (51.6, −51.6), F08 (−58.7, 58.7).

A compass word only fixes the bearing to within ±22.5°. With that uncertainty, the straight-line separations of the engine's unknown-length edges are:

| Edge | Schematic straight line | Range over ±22.5° bearing sectors | Note |
|---|---:|---:|---|
| F01–F04 | 67.3 cm | 44.0–103.0 cm | Triangle bound: ≥ 92−48 = 44 cm |
| F04–F05 | 152.6 cm | 118.4–165.0 cm | |
| F08–F05 | 156.0 cm | 144.7–156.0 cm | |
| U01–F10 | — | — | U01 has no position |

These figures are **constraints for a validator, not lengths**. A walking path is at least as long as the straight line. Because no edge reaches F05 directly, its narrative 73 cm cannot be walked under the current topology: the shortest route is N00→F08→F05, which is at least 83 + 144.7 ≈ 228 cm. This may be intended (an obstacle) or an artefact, and the Owner should decide. It must not be "fixed" for visual reasons.

### 0.3 Existing nest docs
- `docs/nest-construction.md` already forbids invented geometry. N00 is a "花盆土丘/縫隙複合巢" with 2 brood spaces, 1 storage space and an outer mud ridge, all `legacy_story_known_qualitative`. Every metric is null.
- The world params have `nest_microclimate.nest_buffer_fraction`=0.55 and `nest_temp_memory`=0.6, both 遊戲假設.
- `docs/research-design-2026-11.md` §1 has a multi-nest design (`ColonyState.nests[]`). It is not implemented.

---

## 1. Literature on *P. megacephala* (grade a)

### R116 (existing ID, verified): Tsuji & Win 2025
- **Citation**: Tsuji K, Win AT (2025). Open and closed economies as possible alternative strategies to resource heterogeneity in ants. *Biology Open* 14(5): bio061976. https://doi.org/10.1242/bio.061976 (PMC12147459, PMID 40424035). Access: full text (PMC).
- **The paper exists.** The current `docs/references.md` R116 row lacks authors and the DOI. Adding them is a doc fix for a later docs PR; no new ID is needed.
- **Species**: *P. megacephala* (polydomous, polygynous, unicolonial; exotic in Okinawa) compared with *P. noda* (monodomous, native).
- **Conditions**: lab only. There were 10 colonies per species and 200 minor workers per nest, with **no majors**. Each pair of nests was set in plastic arenas 23 × 16.5 × 9 cm with Petri-dish nests, joined by two 1 m tubes (10 mm diameter). There were split-diet treatments (sugar-only vs protein-only nest), connected vs clipped tubes, and a 35-day run.
- **Observed**:
  - In *P. megacephala*, brood production collapsed when the tubes were clipped and stayed close to the fully fed control when the nests were connected.
  - Rhodamine-B dye moved between nests (trophallaxis), and marked workers were found in both nests.
  - The 1 m spacing was chosen because "in the field we often observed *P. megacephala* nests located within this distance". Nests were sometimes farther apart.
  - Main habitats are disturbed sites such as urban parks and beachside sand.
- **Mechanism supported**: inter-nest exchange of food and workers through physical connections, and dependence of a nest on connected nests when its diet is unbalanced ("open economy").
- **Numbers**: 1 m inter-nest spacing is a qualitative field remark, so 文獻支持 (qualitative) applies only to "nests often within ~1 m". All flow rates are lab-specific.
- **Not extrapolable**: no majors, artificial food, Petri-dish nests, tube connections (no soil, no weather). It says nothing about nest architecture.

### R95 (existing): Warner & Scheffrahn, UF/IFAS EENY-369 / IN712
- **Citation**: Warner J, Scheffrahn RH. *Bigheaded Ant, Pheidole megacephala (Fabricius)*. UF/IFAS Featured Creatures EENY-369 / EDIS IN712 (revised; references to 2022). https://edis.ifas.ufl.edu/publication/IN712. Access: full text (PDF; text in `dl_ifas/`, `scripts/in712.txt`).
- **Species**: *P. megacephala*, southern Florida; extension or pest-control observations.
- **Nest sites (verbatim)**: "disturbed soils, lawns, flowerbeds; under objects such as bricks, cement slabs, or flower pots; around trees or water pipes; along the base of structures; and walkways, where displaced soil is usually observed from the action of ants digging below the surface."
- **Other observations**:
  - "Foraging tunnels having numerous entrances can be seen along the soil surface."
  - The ant "may create debris-covered foraging tubes … much more fragile than termite tubes. More often these ants leave piles of loose sandy soil."
  - Populations spread "by following along these lawn-walkway edges".
  - Colonies are numerous and "populations usually extend across property lines".
  - Figures show brood "under a stone on soil" and a "nest site in sandy soil after rain".
  - Ants also nest in wall voids.
- **Mechanisms supported**: shallow digging under cover objects with soil deposited at the surface; many entrances; edge habitats (lawn–paver boundaries); flower pots as cover objects (consistent with N00).
- **Numbers**: none.
- **Not extrapolable**: Florida pest-control context, with no depths or nest counts.

### R290 (new): Forel 1893, quoting H. H. Smith field notes (St Vincent)
- **Citation**: Forel A (1893). Formicides de l'Antille St. Vincent. Récoltées par Mons. H. H. Smith. *Transactions of the Entomological Society of London* 1893: 333–418 (*P. megacephala* treatment pp. 417–418). Plazi treatment D105E0F3795E0111F56D835EEF66929B; https://doi.org/10.5281/zenodo.6293000. Access: full treatment text (via the Plazi/Zenodo summary tool; the quotations below are short).
- **Species**: *P. megacephala*, Caribbean (St Vincent), 1890s field notes.
- **Observed**:
  - Nests are "under turf on a rock; shore of a stream" and "under a stone".
  - "The chambers were large, some of them four inches long and wide, but not high". Under a stone: "a large chamber, about 6 × 4 in., but not high".
  - Chambers were "partly built up with walls of wood-fibre or some similar substance". There were "galleries, covered with a substance apparently formed of wood-fibre and earth".
  - "It does not tunnel more than an inch or two below the surface of the ground, so far as I can discover."
  - Passages ran "partly under stones, or by the sides of posts … partly in the ground near the surface", and one site was "probably … a branch of the main nest, which may have been some distance away."
- **Mechanisms supported**: flat, wide chambers in the gap under a cover object; very shallow tunnelling; walls built from carton-like fibre and earth; branch nests (polydomy).
- **Values**: chambers about 10 × 10 cm up to about 15 × 10 cm footprint ("not high"); tunnelling depth about 2.5–5 cm. Class: **文獻支持 (anecdotal, n of a few nests, one island, 1890s)**.
- **Not extrapolable**: an anecdote with no measurements, no sample size and a different climate. Use it only as an upper-order-of-magnitude plausibility pattern, never as N00 geometry.

### R94 (existing): Yuan et al. 2026, *Insects* 17(10): 992
- As summarised in the repo (`docs/species-pheidole-megacephala.md` §4): in Guangxi field collections the species preferred **moist, shaded pre-existing crevices or cavities** and did not usually build large exposed mounds.
- The MDPI full text returned HTTP 403 in this session, so this is not re-verified here and is used as already cited in the repo.

### R93 (existing): TaiEOL
- Taiwan record: gardens, urban green space, grassland and farmland; under stones, fallen logs and in soil. It is the Taiwan-specific habitat basis.

### R291 (new): Hoffmann, Andersen & Hill 1999
- **Citation**: Hoffmann BD, Andersen AN, Hill GJE (1999). Impact of an introduced ant on native rain forest invertebrates: *Pheidole megacephala* in monsoonal Australia. *Oecologia* 120(4): 595–604. https://doi.org/10.1007/PL00008824 (PMID 28308311). Access: abstract.
- **Species and conditions**: *P. megacephala* at Howard Springs, NT, Australia, in a rain-forest patch in the monsoonal tropics.
- **Observed**:
  - The infestation covered about 25 ha, **centred on drainage lines and rain forest**.
  - The range **expanded about 12 m in the dry season and contracted about 7 m in the wet season**.
  - The ant can spread into savanna by occupying sheltered microsites (beneath logs, at tree bases). It is unlikely to reach high densities in open savanna because of "relative intolerance of desiccation".
- **Mechanisms supported**: humidity and shelter limit where nests are; nest occupation boundaries shift seasonally (population-level emigration or contraction).
- **Values**: +12 m and −7 m seasonal boundary shifts (文獻支持, population-scale only).
- **Not extrapolable**: landscape scale (hectares), not one garden colony. The direction of the wet-season contraction may depend on local flooding regime.

### R146 (existing): Asfiya et al. 2016, *Myrmecological News* 22: 43–54
- From the abstract: in the lab, high temperature strongly reduced *P. megacephala* worker survival, **especially under low moisture**. In the field, bait activity tracked soil-surface temperature, and occupancy was higher in cooler mornings than in hot afternoons.
- **Mechanism**: a temperature × moisture interaction on survival, which supports keeping cavity moisture and temperature coupled.
- **Values**: not read (abstract only), so null.

### R154 (existing): Frazer & Holway 2025, *Biological Invasions* 27: 139
- Desiccation assays at about 90%, 55% and 7% RH. *P. megacephala* tolerance overlapped broadly with *L. humile* (search-snippet level). This is a counterweight to "intolerant of desiccation" (R291).
- **Conclusion for the model**: the direction of the desiccation risk is supported, but the magnitude is uncertain. Keep all thresholds null.

### R292 (new): Milligan et al. 2022
- **Citation**: Milligan PD, Martin TA, Pringle EG, Riginos C, Mizell GM, Palmer TM (2022; online 2021). A soil-nesting invasive ant disrupts carbon dynamics in saplings of a foundational ant–plant. *Journal of Ecology* 110(2): 359–373. https://doi.org/10.1111/1365-2745.13803. Access: abstract (via NSF PAR record).
- **Species and conditions**: *P. megacephala* in Laikipia, Kenya, with screenhouse and field data.
- **Observed**: soil nesting around *Acacia drepanolobium* sapling roots was associated with >58% lower whole-crown photosynthesis and >31% lower pre-dawn leaf water potential.
- **Mechanism supported**: the species nests in soil **at plant root zones**, which supports a `root_zone` surface or microsite class.
- **Not extrapolable**: plant-physiology effects are outside this model and must not create a feedback to plants without a separate world-rule PR (CLAUDE.md §2.2 allows a plant effect only if it is an ecological process, not driven by colony need).

### R293 (new): Wetterer 2002
- **Citation**: Wetterer JK (2002). Ants of Tonga. *Pacific Science* 56(2): 125–135. https://doi.org/10.1353/psc.2002.0019. Access: search snippet only.
- **Observed**: in many areas *P. megacephala* was "under almost every rock and log". This is island-invasion density; it supports the stones and logs pattern only.

### R294 (new, grey literature): Jackson 2023, Pacific Pests, Pathogens, Weeds & Pesticides
- **Citation**: Jackson G (2023). *Bigheaded ant (361)*. Pacific Pests, Pathogens, Weeds & Pesticides, online edition (Lucidcentral). https://apps.lucidcentral.org/pppw_v12/text/web_mini/entities/bigheaded_ant_361.htm. Access: full (fact sheet).
- **Observed**: "Nests under logs, stones, tree bark, leaf litter, and occasionally in houses." "Prefers disturbed areas." Spread is "by 'budding' – queens, workers and brood move to new sites."
- Supports the leaf-litter and bark microsite classes and budding as a relocation mode. It is a secondary source, so weight it low.

### R311 (new, minor): Lenoir et al. 2025
- **Citation**: Lenoir A, Perdereau E, Dupont S, Libbrecht R, Picquet P, Galkowski C, Mercier J-L (2025). The tropical ant *Pheidole megacephala* (Fabricius, 1793) in France and discrimination with the local *Pheidole pallidula*. *Naturae* 2025(4): 35–43. https://doi.org/10.5852/naturae2025a4. Access: abstract or metadata.
- Records from **heated greenhouses** in France. This supports the idea that the species persists only in sheltered warm anthropogenic microsites outside the tropics. It is not relevant to Taichung's climate except as a plausibility check that cover objects and pots matter.

### Existing species refs reused (no new ID)
- R99 (Sarnat 2015): invasive polydomy and budding.
- R101/R110/R113 (Fournier 2009/2012): supercolony recognition differs by population.
- R137 (Wetterer 2007): household pest nesting indoors; not re-read this session.
- R140 (Reimer 1991): metre-by-metre spread.
- R153 (Pietrek 2021): about 50 m/yr in Kenya.

### What was searched and NOT found for *P. megacephala*
- Measured nest depth, chamber count or volume, entrance count, nest casts.
- Nest density per m².
- Nest-relocation frequency and its triggers (rain, flooding, temperature).
- Brood-transport rates.
- Soil-pellet size and excavation rate.
- Humidity or temperature preference gradients for nest choice.
- CTmax (the related *P. nodus* has seasonal plasticity; Nascimento et al. cover other *Pheidole*; not used).
- Levee building.

**All of the above stay `null` (grade c).**

---

## 2. Other species (「非本種」, grade b): mechanisms only

### R295 (new): Droual & Topoff 1981, *Pheidole hyatti* and *P. desertorum* (非本種, same genus)
- **Citation**: Droual R, Topoff H (1981). The emigration behavior of two species of the genus *Pheidole* (Formicidae: Myrmicinae). *Psyche* 88(1–2): 135–150. https://doi.org/10.1155/1981/43265. Access: full text (OCR HTML).
- **Conditions**: Arizona oak-juniper woodland and New Mexico desert grassland, June–August 1980, nightly checks.
- **Observed**:
  - Emigration was frequent: more than half the colonies moved at least 4 times (*P. desertorum*) or 6 times (*P. hyatti*) in one summer, up to 16.
  - Distances were 1.8 ± 1.0 m (*P. hyatti*, N = 137) and 2.5 ± 1.4 m (*P. desertorum*, N = 102; range 0.4–6.9 m).
  - **42–49% of moves went back to former nest sites**.
  - Moves correlated positively with daily rainfall (rs ≈ 0.25–0.32). In the grassland, 3 moves occurred in the 29 days before the first heavy rain and 29 moves in the 9 days after it; the authors attribute this to rain softening soil.
  - Brood was carried in columns, and the queen walked, escorted.
  - Excavation at a future site often preceded the move. Some moves were aborted.
- **Mechanisms**:
  - Former nests remain candidates and are remembered.
  - Wet soil makes excavation easier and can make moves more likely.
  - Moves are partial or abortable.
  - The queen walks and is not carried.
- **Not extrapolable**: arid North American habitats, different colony sizes, monodomous species. Relocation frequency and distances are **not** *P. megacephala* values (class 遊戲假設 if ever used).

### R296 (new): Moyano & Feener 2014, *Pheidole dentata* (非本種)
- **Citation**: Moyano M, Feener DH Jr (2014; online 2013). Nest relocation in the ant *Pheidole dentata*. *Insectes Sociaux* 61(1): 71–81. https://doi.org/10.1007/s00040-013-0327-1. Access: abstract (search snippet; the Springer page was blocked).
- **Observed**: 505 nest sites of 176 colonies were followed for 6 weeks (conference abstract). Higher leaf-litter depth and **vapour pressure deficit** raised relocation probability. **No evident effect of rain or surface cover.**
- **Mechanism**: drying of air or soil (VPD) can trigger relocation. This contrasts with R295 (rain), so the direction of the rain effect is genus-inconsistent.
- **Not extrapolable**: species and region. The leaf-litter direction conflicts between the conference and journal versions.

### R297 (new): Wilson 1986, *Pheidole* flood evacuation (非本種 unless verified)
- **Citation**: Wilson EO (1986). The organization of flood evacuation in the ant genus *Pheidole* (Hymenoptera: Formicidae). *Insectes Sociaux* 33: 458–469. https://doi.org/10.1007/BF02223951. Access: abstract (search snippet).
- **Observed**: *P. cephalica* minors react to small amounts of water at the nest entrance with **alarm runs** through the nest. Moving water was more effective than standing water. 25 other *Pheidole* species were tested; some use alarm waves only. Alarm runs are more common in rotting-wood nesters.
- **Mechanism**: water contact at the entrance is a **local** cue that triggers evacuation. This fits the no-god-view rule: a worker must touch the water.
- **Not extrapolable**: whether *P. megacephala* was among the 25 species is **not verified**, so the flood-alarm switch for the species stays null.

### R298 (new): LeBrun, Moffett & Holway 2011, floodplain levees (非本種; includes 2 *Pheidole*)
- **Citation**: LeBrun EG, Moffett MW, Holway DA (2011). Convergent evolution of levee building behavior among distantly related ant species in a floodplain ant assemblage. *Insectes Sociaux* 58(2): 263–269. https://doi.org/10.1007/s00040-011-0151-4 (PMC3059759). Access: full text (PMC).
- **Conditions**: Paraná floodplain, Santa Fe, Argentina, January–February 2009.
- **Observed**:
  - Earthen berms appeared about 24 h after the first substantial rain.
  - *Pheidole* cf. *obscurithorax* berms were 2.9 ± 0.9 cm high and 8.6 ± 2.9 cm across (N = 7) and kept out 1 cm of floodwater in 4/4 nests.
  - *P. jelseki* built an unconsolidated ring about 5 cm from the entrance, and both such berms failed.
  - Breached levees reduced foraging for hours.
- **Mechanism**: entrance-levee building after rain is a genus-level capacity, not universal.
- **Not extrapolable**: the *P. megacephala* levee capacity is unknown, so `entrance_levee_building` = null (default off). This also means the N00 "泥脊" stays story history only.

### R299 (new): Kolay & Annagiri 2015, *Diacamma indicum* (非本種)
- **Citation**: Kolay S, Annagiri S (2015). Dual response to nest flooding during monsoon in an Indian ant. *Scientific Reports* 5: 13716. https://doi.org/10.1038/srep13716. Access: full text (PDF in `dl_kolay/`).
- **Observed**:
  - In the monsoon, only 25.6% of nests were subterranean, compared with 70–83% in other seasons.
  - Entrance elevation was a median 17.8 cm in the monsoon versus 0 cm in other seasons.
  - Mild rain (8.6 mm/day) led to rebuilt entrances (soil mounds, decorations). Water around the entrance triggered building; water inside the chamber alone did not.
  - Soil balls were carried out after showers.
  - In lab flooding, colonies evacuated, and 8/11 chose a higher nest (not significant).
- **Mechanisms**: entrance elevation and drainage as nest-site traits; local water cues at the entrance trigger entrance building; flooding leads to evacuation.
- **Not extrapolable**: a monomorphic, single-chamber ponerine with 20–300 adults.

### R300 (new): McGlynn 2012, review of nest movement
- **Citation**: McGlynn TP (2012). The ecology of nest movement in social insects. *Annual Review of Entomology* 57: 291–308. https://doi.org/10.1146/annurev-ento-120710-100708. Access: abstract.
- **Content**: most social insects relocate periodically. The relocation types are legionary nomadism, unstable nesting, intrinsic relocation and adventitious relocation. Drivers include growth, competition, foraging, microclimate, nest deterioration, parasites, predation and seasonality.
- **Use**: taxonomy of relocation causes for the design. No numbers.

### R301 / R302 (new): polydomy reviews
- **R301**: Debout G, Schatz B, Elias M, McKey D (2007). Polydomy in ants: what we know, what we think we know, and what remains to be done. *Biological Journal of the Linnean Society* 90(2): 319–348. https://doi.org/10.1111/j.1095-8312.2007.00728.x. Access: metadata only (definitions).
- **R302**: Robinson EJH (2014). Polydomy: the organisation and adaptive function of complex nest systems in ants. *Current Opinion in Insect Science* 5: 37–43. https://doi.org/10.1016/j.cois.2014.09.002. Access: metadata only.
- **Use**: terminology only (polydomy = one colony, several spatially separate nests with exchange). Neither is read in full, so do not cite them for numbers.

### R303 (new): Forti et al. 2007, *Pheidole oxyops*. A deep nest that must NOT be copied
- **Citation**: Forti LC, Camargo RS, Fujihara RT, Lopes JFS (2007). The nest architecture of the ant, *Pheidole oxyops* Forel, 1908. *Insect Science* 14(5): 437–442. https://doi.org/10.1111/j.1744-7917.2007.00171.x. Access: abstract (search snippet; re-check before quoting).
- **Observed**: nests up to about 5.09 m deep with 4–14 chambers (Brazil).
- **Use in this design**: an explicit counter-example. Even within *Pheidole*, nest depth spans centimetres (R290) to metres (R303). The species parameter must come from *P. megacephala* evidence only. **Deep vertical architectures are forbidden as defaults.**

### R304 (new): Tschinkel 2015, review of subterranean nest architecture
- **Citation**: Tschinkel WR (2015). The architecture of subterranean ant nests: beauty and mystery underfoot. *Journal of Bioeconomics* 17(3): 271–291. https://doi.org/10.1007/s10818-015-9203-6. Access: metadata only. The existing R69/R70/R77 are Tschinkel's casts of *Camponotus socius*, *Formica pallidefulva* and *Pogonomyrmex badius*.
- **Use**: an explicit **do-not-copy** list. *Pogonomyrmex badius* (metres deep, top-heavy chamber stacks), *Atta* (R71/R75/R76: thousands of chambers, ventilation turrets) and *Solenopsis invicta* mounds (thermoregulatory mounds) are species-specific. None of their depth, chamber counts, chamber-area-versus-depth curves, turrets or mound thermoregulation may be applied to *P. megacephala*.

### R305 (new): Monaenkova et al. 2015, *Solenopsis invicta* excavation (非本種)
- **Citation**: Monaenkova D, Gravish N, Rodriguez G, Kutner R, Goodisman MAD, Goldman DI (2015). Behavioral and mechanical determinants of collective subsurface nest excavation. *Journal of Experimental Biology* 218(9): 1295–1305. https://doi.org/10.1242/jeb.113795 (PMID 25954041). Access: abstract.
- **Observed**:
  - Excavation was possible in all substrates except completely dry or fully saturated ones.
  - Tunnels were deepest at intermediate moisture, and depth correlated with cohesion.
  - Pellets were made of wetted particles, and **pellet size was similar across conditions**, apparently set by carrying ability and crowded-tunnel constraints.
- **Mechanisms**: excavation needs a moisture window; work is quantised into pellets of about constant size, carried one per trip.
- **Not extrapolable**: pellet mass and digging rate (fire-ant size and silica substrate).

### R306 (new): Toffin et al. 2009, *Messor sancta* (非本種)
- **Citation**: Toffin E, Di Paolo D, Campo A, Detrain C, Deneubourg J-L (2009). Shape transition during nest digging in ants. *PNAS* 106(44): 18616–18620. https://doi.org/10.1073/pnas.0902685106. Access: abstract.
- **Observed**: 2-D digging goes from a circular cavity to branched galleries, more often with more workers. The shape emerges from density effects in a stochastic model.
- **Mechanism**: chamber or gallery shape can emerge from local crowding. It justifies representing cavities as a graph of nodes rather than imposing shapes.

### R307 (new): Buhl et al. 2005 (非本種)
- **Citation**: Buhl J, Deneubourg J-L, Grimal A, Theraulaz G (2005). Self-organized digging activity in ant colonies. *Behavioral Ecology and Sociobiology* 58(1): 9–17. https://doi.org/10.1007/s00265-004-0906-2. Access: metadata only.
- **Use**: the digging rate rises then falls (self-organised) without a central controller. Mechanism only. The existing R73 covers similar ground for *Solenopsis*.

### R308 (new): Mlot, Tovey & Hu 2011, fire-ant rafts. Do NOT copy
- **Citation**: Mlot NJ, Tovey CA, Hu DL (2011). Fire ants self-assemble into waterproof rafts to survive floods. *PNAS* 108(19): 7669–7673. https://doi.org/10.1073/pnas.1016658108. Access: metadata only.
- **Use**: listed only so that rafting is **not** given to *P. megacephala*. No evidence was found for it.

### Existing refs reused (non-species)
- R158 (Heller & Gordon 2006, *L. humile*): nests moved within a day after humidity change.
- R71 (*Atta vollenweideri* soil moisture).
- R72 (brood relocation leading to excavation).
- R73 (collision cues).
- R74 (age and digging).
- R14/R78 (temperature and architecture).

---

## 3. Physical and geographic references (not biology)

### R309 (new): Campbell & Norman 1998
- **Citation**: Campbell GS, Norman JM (1998). *An Introduction to Environmental Biophysics*, 2nd ed. Springer. https://doi.org/10.1007/978-1-4612-1626-1. Access: metadata (standard textbook content, not re-read this session).
- **Use**: soil heat conduction. The diurnal temperature amplitude decays roughly as exp(−z/D), where the damping depth is D = √(2κ/ω). D depends on soil thermal diffusivity κ, which depends on texture and water.
- **Values**: κ for the N00 soil is **unknown, so null**. Textbook-typical daily D of order 10 cm can only be a 遊戲假設 with a physics mechanism; it is not a measurement. Shallow nests (R290: 2.5–5 cm) therefore track surface temperature closely. A cover object (stone, pot, paver) changes this through its own heat capacity and shading, and its parameters are null.

### R310 (new): Central Weather Administration, Taichung station page
- **Citation**: 中央氣象署, 臺中氣象站 station page. https://etour.cwa.gov.tw/station_inpage.php?stn_id=8. Access: full (fetched 2026-11-02).
- **Values (1991–2020 normals)**: mean temperature 23.3 °C, precipitation 1773.0 mm, 113.7 rain days, **sunshine 2043.2 h/yr**.
- **Location**: the station is at 臺中市北區精武路295號, **not in Xitun**. Its latitude, longitude and elevation were not shown on the page, so they are left null here and should be taken from CWA open data.
- **Model use**: these are measured statistics, used as priors (assumption: true). The repo already uses the first three numbers (`docs/historical-climate-weather-engine.md`). The sunshine total is new and relevant to a future insolation interface.

**Garden latitude**: Xitun District lies at about 24.15–24.20° N. This is a geographic approximation, not a property coordinate, because the villa is fictional. For a future solar-geometry interface it is enough to declare `latitude_deg_for_solar_geometry` as a scenario assumption. No street address exists.

---

## 4. Synthesis: what the nest model may assume for *P. megacephala*

| Topic | Supported (grade a) | Mechanism only (grade b, 非本種) | Unknown, so null |
|---|---|---|---|
| Nest sites | Under cover objects (bricks, slabs, **flower pots**, stones, logs), in disturbed soil, lawns, flowerbeds, along structure bases, walkway edges, tree bases and pipes, leaf litter, bark, rotten wood, wall voids (R95, R290, R93, R94, R291, R293, R294) | — | Site-choice weights |
| Structure | Shallow (about 2.5–5 cm, anecdotal), wide, flat chambers (about 10–15 cm footprint) under stones; carton-like fibre and earth walls; uses pre-existing crevices; no big mounds; many entrances; loose-soil spoil piles at the surface (R290, R94, R95) | Chamber or gallery shapes emerge from crowding (R306) | Depth, volume, chamber count and entrance count at N00 |
| Polydomy | Polydomous, unicolonial; nests often within ~1 m; worker and food exchange via connections; budding with queens and brood (R116, R99, R294, R290) | Food flows only along connected paths (R157 *L. humile*) | Number of nests, flow rates, spacing in this garden |
| Moisture and temperature | Heat × dryness reduces survival (R146); desiccation limits open habitats (R291) but tolerance is similar to *L. humile* (R154); concentrated along drainage lines (R291) | Digging moisture window (R305, R71); VPD triggers moves (R296) | Thresholds, cavity RH and temperature |
| Flooding and emigration | Seasonal boundary contraction in the wet season (R291) | Rain increases moves (R295) or does not (R296); water at the entrance triggers alarm (R297), levees (R298, two *Pheidole*) and evacuation (R299); return to old nests (R295) | Whether the species shows alarm runs, levees or rafts; any rates |
| Construction | Digs under pavement and displaces soil (R95) | Pellets of about constant size, one per trip (R305); self-organised digging rate (R307, R73) | Pellet mass, digging rate |

**Must not copy**:
- *Pogonomyrmex* depth or chamber stacks (R77, R304).
- *Atta* ventilation, turrets and huge nests (R71, R75, R76).
- *Solenopsis invicta* thermoregulatory mounds and rafts (R305, R308).
- *Pheidole oxyops* 5 m nests (R303).
- *Camponotus*/*Formica* volume-to-worker regressions (R69, R70).

---

## 5. Questions for the Owner (do not fix silently)

1. **Topology mismatch.** The legacy map has N00–F04 (92), N00–F05 (73) and U00–U01. The engine has F01–F04, F04–F05, F08–F05 and N00–U01, with no direct N00–F04/F05. Is there an intended barrier (wall or water) that makes F05 reachable only via F08 (at least about 228 cm by the schematic bound)? Or should the Day15+ topology be reviewed in a separate rules PR?
2. **Meaning of the narrative distances.** Are 92 cm and 73 cm "straight line from the N00 entrance" (as `extrapolation_limit` says for the four recorded edges)? If so, the geometry file keeps them as site attributes, not edge lengths.
3. **N00 setting.** Is "高處倒置花盆" a pot on raised ground or on a step? It decides entrance elevation, which is null now.
4. **North.** Should the bearings be read as true north? This is a scenario assumption either way.
5. **Edits to R116.** Should the existing row get its authors and DOI added (a docs-only fix)?
