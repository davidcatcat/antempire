# P1-A working notes: major workers ("soldiers") of *Pheidole megacephala*

Checked 2026-11-02. Research working notes, copied into the repo unchanged apart from this header; no game day was advanced.

Builds on: `docs/references.md` (R1–R188 on main), `docs/research-design-phase3-lifecycle.md` and `reports/phase3-lifecycle/literature-notes.md` on branch `origin/claude/ant-empire-engine-refactor-i45q93-phase3-lifecycle-design` (R204–R227). Another agent holds R228–R259. **New IDs here start at R260.** Sources that already have an ID keep it (no duplicates).

Downloads were kept outside the repo (not committed); text was extracted with `pdftotext` or a small XML-to-text script. Scanned pages were rendered with `pdftoppm` and read as images.

Read-status codes: **FULL** (whole text read), **FULL-PART** (full text in hand, relevant sections read), **IMG** (scanned page images read), **ABS** (abstract only), **TOOL** (only via a search/summary tool; wording not verified line by line), **SEC** (only via a citing paper).
Class: **(a)** *P. megacephala*; **(b)** other species = 「非本種」; **(g)** general physiology / method.
Number classes used in the design: 文獻支持 / 一般生理學 / 遊戲假設.

---

## 0. Bottom line

1. **Morphology (a)**: complete dimorphism, no intermediates (R97, R98). Head width majors 1.10–1.54 mm vs minors 0.50–0.61 mm (R99, measurements from Fischer & Fisher 2013, n = 19/20). Dry mass majors ≈ 390–1110 µg vs minors ≈ 63–97 µg, i.e. **major:minor dry-mass ratio ≈ 5.4–6.3 in four populations and ≈ 11.4 in Australia** (R97 Fig. 2, read from the figure). Fresh mass (Cameroon) 1.65 vs 0.35 mg → ratio 4.7 (R98/R132).
2. **Caste ratio (a)**: field nest samples 0.06–0.25 majors (population means; R97); lab eclosion cohort 11.86 % (14/118, 28 °C; R94). Not different among populations with very different ant communities (R97). Small lab nests (≤ 100 individuals) produced only minors (R167). Soldier brood absent in winter–early spring (R94).
3. **Determination**: no *P. megacephala* experiment exists. Mechanism from congeners (非本種): final-instar size/JH threshold with a sensitive window (R174, R269), protein needed (R212, R175), ≥ 24 °C needed (R175), adult soldiers inhibit (R174, R213), competitor contact raises production (R270). Wing-disc pattern of soldier development confirmed in *P. megacephala* (R142).
4. **Liquid food (a)**: only primary study is Dejean et al. 2005 (R132): crop load 0.26 ± 0.02 mg (majors) vs 0.08 ± 0.01 mg (minors) of honey; majors can additionally carry an external droplet (~0.86 mg; total up to 1.88 mg) and share it as a "social bucket". This is **transport**, not storage. **No study shows *P. megacephala* majors acting as repletes**; Tsuji 1990 (R260, *P. ryukyuensis*) explicitly notes that *P. megacephala* "apparently lack[s] repletes" (personal observation). Seed milling by *P. megacephala* majors: **no primary study found**.
5. **Recruitment & defence (a)**: soldiers are 1.07 ± 1.89 % of recruits to honey on neutral ground vs 8.16 ± 3.70 % on competitor-marked ground (R132), but ≈ 28–32 % of recruits to moth-egg clusters (which they open with their mandibles; R98/R107 Fig. 4B). Soldiers dismember spread-eagled enemies/prey (R173). Mechanism of selective recruitment (higher response thresholds of majors to trail and tactile invitations) is shown only in *P. pallidula* (R263–R266, 非本種).
6. **Survival (a)**: R94 only (28 °C, ad lib, n = 14 majors): mean 56 d, KM median 70 d vs minors 26.25 / 28 d. Phase-3 Gompertz fits (not the authors'): majors A = 0.0025 d⁻¹, B = 0.044 d⁻¹.

---

## 1. Sources (new reads marked NEW)

### 1.1 R97 Wills, Moreau, Wray, Hoffmann & Suarez 2014, *Biol. J. Linn. Soc.* 113:423–438, DOI 10.1111/bij.12386 — (a), **FULL** (NEW full read; R97 already exists)
- URL used: moreaulab.entomology.cornell.edu PDF (author lab copy).
- **Design**: 5 introduced(?) populations — Howard Springs (Australia, 4 nests), Sabi Sands (South Africa, 3; possibly native range), Sarasota (Florida, 5), Mauritius (4), Hawaii Volcanoes NP (6); 22 nests total. Per nest 25 minors + "as many major workers as available (mean ± SE 8.82 ± 1.22, range 3–20)" dried 50 °C ~48 h, weighed (0.1 µg). HL, HW, PW, tibia measured. Ethanol-stored (no fat content).
- "workers are completely dimorphic and worker sub-caste was easily distinguished based on overall size and the shape of the head."
- **Dry mass (read from Fig. 2 bars, ±~10 µg reading error)**: majors — Australia ≈ 1110, S. Africa ≈ 530, Florida ≈ 450, Mauritius ≈ 390, Hawaii ≈ 395 µg; minors — Australia ≈ 97, S. Africa ≈ 84, Florida ≈ 84, Mauritius ≈ 63, Hawaii ≈ 71 µg.
  - My arithmetic, major:minor dry-mass ratio: 11.4 / 6.3 / 5.4 / 6.2 / 5.6.
  - Majors differed (F4,17 = 29.73, P < 0.0001), Australia > all others. Press release "three times more massive than in Hawaii" is consistent (1110/395 = 2.8).
- **Mass threshold separating castes** (logistic isoclines, Fig. 4): differed among populations (F4,17 = 6.14, P = 0.003), Australia larger; numeric values only on the figure (x-axis 0–1000 µg).
- **Proportion of majors** (mean ± SE): Australia 0.21 ± 0.1, South Africa 0.25 ± 0.06, Florida 0.06 ± 0.01, Mauritius 0.19 ± 0.01, Hawaii 0.19 ± 0.06; not significant (F4,17 = 2.67, P = 0.06). Text: "0.06–0.26 … similar to … Neotropical Pheidole (0.05–0.20; 0.02–0.27)".
  - Proportion = majors / all ants collected from a nest. Authors: "our sampling design may have been insufficient to accurately estimate the proportion of majors in each nest"; whole-colony excavation is impractical in this unicolonial species.
- Discussion cites: soldier presence inhibits soldier production (Wheeler & Nijhout 1984); seasonal variation with sexual larvae (Johnston & Wilson 1985 etc.); *P. morrisi* Florida more, smaller majors (Yang et al. 2004, SEC); NY/NJ workers stored more fat (Yang 2006, SEC).
- **Not extrapolable**: field population means; nests are fragments of unicolonial supercolonies; timing/season not standardised; the colony-size dependence was not tested. Proportions are of *collected* ants, likely biased by where ants were collected. Mass values are from a figure (my reading).

### 1.2 R99 Sarnat, Fischer, Guénard & Economo 2015, *ZooKeys* 543:1–109, DOI 10.3897/zookeys.543.6050 — (a) taxonomy, **FULL-PART** (Europe PMC XML, PMC4714327)
- Table 1 and species account: *P. megacephala* **major HW 1.10–1.54 mm, HL 1.04–1.59, SL 0.59–0.76 (n = 19); minor HW 0.50–0.61, HL 0.57–0.68 (n = 20)**, measurements from Fischer & Fisher 2013 (Malagasy-region revision; SEC for the raw data).
- Polygynous, unicolonial, dependent colony founding, colony size "10,000+ (?)".
- My arithmetic: minor/major HW ratio at range midpoints 0.555/1.32 ≈ 0.42 (range of possible ratios 0.32–0.55). Compare *P. pallidula* 0.42 and *P. guilelmimuelleri* 0.39 (via R261).
- **Not extrapolable**: museum specimens, mixed localities; Taiwan specimens not separated.

### 1.3 R132 Dejean, Le Breton, Suzzoni, Orivel & Saux-Moreau 2005, *Naturwissenschaften* 92:324–327, DOI 10.1007/s00114-005-0632-2 — (a), **FULL** (re-read for majors)
- Cameroon, 4 field colonies + 1 lab colony. Minors ≈ 2 mm, soldiers 3–4 mm.
- 30 paired field trials: 0.3 ml honey on A3 sheet, neutral vs *Oecophylla*-marked (48 h). Count at 12 min after discovery.
  - Recruits 28.53 ± 5.67 vs 33.97 ± 6.14 (mean ± SD); **% soldiers 1.07 ± 1.89 vs 8.16 ± 3.70**.
  - Scouts "first filled their crops before returning to their nests".
  - Some soldiers "patrolled around the drop of honey … probably to defend the food source".
  - Soldiers with external droplet: 21/30 marked vs 2/30 neutral areas. Lab: 27 % of 74 recruited soldiers (4 % head only, 23 % head + thorax).
- **Loads (microbalance)**: crop honey minors 0.08 ± 0.01 mg vs soldiers 0.26 ± 0.02 mg (mean ± SE; 10 + 10 ants × 5 series). Soldiers with external droplet: total up to 1.88 mg, mean 1.12 ± 0.01 mg, "often more than their own body weight (average 1.65 mg)"; droplet ≈ 0.86 mg.
  - My arithmetic: crop load ratio 3.25×. Relative to body mass: minors 0.08/0.35 ≈ 23 %; soldiers 0.26/1.65 ≈ 16 % (crop) or ≈ 68 % (crop + droplet, mean).
- In the nest, starved workers lick the droplet ("social bucket"), then normal trophallaxis.
- Intro (general *Pheidole* statement citing Sempo & Detrain 2004, not a finding for this species): majors "specialised in colony defence, food storage, seed milling and foraging for large food sources, but also able to perform tasks inside the nest".
- **Not extrapolable**: concentrated honey (high viscosity limits crop loading); single season; native-range large colonies; loads are what ants carried, not maximum crop volume; % soldiers depends on the bait context.

### 1.4 R98/R107 Dejean, Moreau, Uzac, Le Breton & Kenne 2007, *C. R. Biologies* 330:701–709, DOI 10.1016/j.crvi.2007.06.005 — (a), **FULL** (re-read for majors; Fig. 4 read from page image)
- Intro: "no intermediary body size between the small minors (approximately 2 mm long; average 0.35 mg) and the big-headed majors (or soldiers; 3–4 mm long; average 1.65 mg)". General *Pheidole* statement: majors "specialized in colony defense and food processing and is much less frequently found outside of the nest".
- Moth (Bombycidae) egg clusters of 6, 12, 24 eggs, N = 12 per case: recruits increase with cluster size (≈ 12–21); **% soldiers ≈ 28–32 % in all cases**, not affected by cluster size or *Oecophylla* landmarks (Kruskal–Wallis P = 0.93–0.94). "The recruited soldiers opened the moth eggs with their powerful mandibles, permitting workers to imbibe the contents"; soldiers sometimes pried eggs off and carried them.
- Termites: spread-eagling and retrieval by "workers" (castes not separated).
- **Not extrapolable**: native-range colonies; artificial baits near nest; % soldiers not reported for termites/cockroaches.

### 1.5 R173 San Juan, Azémar & Dejean 2025, *Ecology* 106:e70113, DOI 10.1002/ecy.70113 — (a), **FULL** (re-read)
- Poinciana, Florida, suburban; one *P. megacephala* colony ≈ 2 ha; June–Nov 2024; observational ("Scientific Naturalist"), case counts only.
- Minors seize appendages and spread-eagle; "recruited P. megacephala soldiers use their powerful mandibles to rapidly kill the prey, cutting off its legs and antennae, removing its gaster, or decapitating it".
- *S. invicta* in one-on-one fights killed "some P. megacephala minor workers and soldiers".
- **Correction needed to the repo summary of R173** ("本種攻擊火蟻時，死亡的多半是兵蟻"): the phrase "less than five deaths, mostly soldiers" is in the paragraph on *Pheidole* sp. cf. *parva* abandoning baits, and it is **not stated which species' soldiers** died. It is not about attacks on fire ants. Proposal: an append-only erratum note (do not edit the old row).

### 1.6 R94 Yuan et al. 2026, *Insects* 17:992 — (a). Not re-read; values taken from the phase-3 notes (FULL there)
- 28 ± 1 °C, ad lib. Eclosion cohort: 14 soldiers / 118 = 11.86 %. Survival (Table S3, 14-d census): minors n = 104, mean 26.25 d, KM median 28; soldiers n = 14: 14, 12, 11, 11, 8, 6, 1, 0 → mean 56, KM median 70. Interval daily hazards (phase-3 arithmetic): soldiers 0.011, 0.006, 0, 0.023, 0.021, 0.128. Gompertz (phase-3 fit): A = 0.0025 d⁻¹, B = 0.044 d⁻¹ (mean 56.5, median 58.7).
- Season: "only worker-destined brood found through winter and early spring, whereas soldier- and reproductive-destined brood appeared from late spring onwards" (internal inconsistency on sexual timing already noted).
- Minors and soldiers pooled for development time → major development time unknown.
- Size: minor ≈ 2.5 mm, major ≈ 3.5 mm (species doc).

### 1.7 R167 Phillips 1933 (PhD thesis, Univ. Hawaii) — (a), FULL in WP4 (not re-read)
- "Nests ≤ 100 individuals produced only minors."
- Workers killed soldiers in small colonies "but not … eat them".

### 1.8 R136 Chang 1985 — (a), FULL in Day0 work (not re-read)
- Queen + major workers (and queen alone, queen + larvae) failed to establish; queen + 10 pupae succeeded 6/6. Composition/number of majors not in the repo summary → re-check before using as evidence of majors' brood-care ability.

### 1.9 R116 Tsuji & Win 2025, *Biology Open* 14:bio061976 (Europe PMC PMC12147459) — (a)+(b), **FULL-PART** (NEW for majors)
- Okinawa *P. megacephala* stock colonies "contained multiple queens and multiple major workers"; experiments used **no majors** "because in Pheidole they are known to serve as repletes (the nutrient storage caste) (Tsuji, 1990; Lachaud et al., 1992; Yang, 2006)".
- Wet mass of 200 *P. megacephala* minors 48.0 ± 2.10 mg (N = 6) → ≈ 0.24 mg per minor (my arithmetic).
- **Conflict**: the same first author wrote in 1990 that *P. megacephala* apparently lacks repletes (R260). The 2025 statement is a genus-level generalisation, not a *P. megacephala* observation.

### 1.10 R260 (NEW) Tsuji K. 1990, *Nutrient storage in the major workers of Pheidole ryukyuensis*. *Appl. Entomol. Zool.* 25(2):283–287, DOI 10.1303/aez.25.283 — (b), **IMG** (all 5 page images read; J-STAGE PDF without text layer)
- One lab colony (Iriomote), 24 ± 2 °C, 16L:8D. Starvation trials (water only), 10 vials each: (A) 20 minors; (B) 20 minors + 1 replete major (distended gaster); (C) 20 minors + 1 non-replete major.
- Minor mean survival: A 8.0 ± 2.6 d (N = 10), **B 31.3 ± 2.3 d (N = 9)**, C 7.4 ± 1.8 d. Major survival: replete 46.1 ± 15.0 d vs non-replete 13.9 ± 2.3 d.
- Repletes paler (younger) and slightly larger: HW 1.23 ± 0.02 vs 1.19 ± 0.04 mm (n = 10 each).
- Dissection: distended majors had crops "filled with transparent liquid".
- **Discussion: "repletes may not be so common in Pheidole, since some species, e.g. P. megacephala, apparently lack repletes (Tsuji personal observation)."**
- Useful non-species numbers: a non-replete major survived starvation ≈ 1.7–1.9× as long as minors (13.9 vs 7.4–8.0 d).
- **Not extrapolable**: different species; single colony; replete function in *P. megacephala* contradicted by the author's own observation.

### 1.11 R261 (NEW) Sempo G. & Detrain C. 2010, *Social task regulation in the dimorphic ant, Pheidole pallidula: the influence of caste ratio*. *J. Insect Sci.* 10:3 (16 pp.), DOI 10.1673/031.010.0301 — (b), **FULL** (Europe PMC PMC3014662)
- 56 queenless experimental colonies with 10, 25, 50, 60, 75, 90 % majors.
- Activity rate (fraction active): in 10 % major colonies minors 70.1 ± 10.8 %, majors 50.8 ± 17.3 % (n = 20); majors stayed at 40–50 % whatever the caste ratio; minors' activity rose slightly when depleted.
- "Majors do not compensate for the depletion of minors by expanding their repertoire or increasing their activity level"; *P. pallidula* majors "nearly as totipotent as minors". Major:minor activity ratio ≈ 0.65 vs 0.05–0.52 in *P. guilelmimuelleri* (Wilson 1984, SEC).
- Replete majors "account for up to 32 % of the total P. pallidula majors population (Lachaud et al. 1992)" and ~50 % of inner-nest majors (personal obs.); they sit in quiet areas or near brood, do not forage or defend.
- Explicit warning: majors' repertoire size depends on sampling effort (methodological bias).

### 1.12 R262 (NEW) Sempo G. & Detrain C. 2004, *Between-species differences of behavioural repertoire of castes in the ant genus Pheidole: a methodological artefact?* *Insectes Soc.* 51:48–54 — (b), **TOOL** (search summary)
- Weighted observations: *P. pallidula* majors perform 69 % of the minors' repertoire, including brood care.

### 1.13 R263 (NEW) Detrain C. 1990, *Régulation du polyéthisme de castes lors de l'exploitation de ressources alimentaires chez la fourmi Pheidole pallidula*. *Actes Coll. Insectes Sociaux* 6:131–139 (first page misprinted "131-130") — (b), **FULL** (French IUSSI section archive, dictionnaire-amoureux-des-fourmis.fr)
- Majors recruited significantly more to unretrievable cockroaches than to individually retrievable *Drosophila* (to which majors do not, or negligibly, go).
- Poison-gland extract (trail pheromone) in the nest: minors 70–80 % moving and stay agitated; majors ≈ 80 % at introduction but fall back to immobility within ~1 min.
- Tactile invitations (Table): short antennal flagellation (< 1 s) by a running recruiter: minors 65 % move, 33 % accelerated runs, 18 % exit (n = 162) vs majors 23 %, 6.4 %, 9.7 % (n = 31); long flagellation (> 1 s): minors 100/80/80 % (n = 10) vs majors 89/22/61 % (n = 18).
- Conclusion: majors have **higher response thresholds** to chemical and tactile recruitment stimuli → they join only when the trail is heavily reinforced and invitations intense (large unretrievable food).

### 1.14 R264 (NEW) Detrain C., Pasteels J. M. & Deneubourg J.-L. 1988, *Polyéthisme dans le tracé et le suivi de la piste chez Pheidole pallidula*. *Actes Coll. Insectes Sociaux* 4:87–94 — (b), **FULL**
- Colonies up to 6000 workers, majors 2–15 % (Passera 1977, SEC).
- Trail pheromone comes from the poison gland, **mainly produced by minors**; majors have little or none.
- On artificial trails majors follow ≈ 2× better than minors at optimal concentrations (1 and 4 glands per trail).
- Defence: minors discover intruders and hold them; majors arrive later and kill them by cutting at the petiole; majors cut sclerites of prey so minors can feed. Majors are "rare and poor explorers".

### 1.15 R265 (NEW) Detrain C. & Pasteels J. M. 1991, *Caste differences in behavioral thresholds as a basis for polyethism during food recruitment in the ant, Pheidole pallidula*. *J. Insect Behav.* 4:157–176, DOI 10.1007/BF01054609 — (b), **TOOL** (abstract fragments). Same conclusion as R263, in a refereed journal.

### 1.16 R266 (NEW) Detrain C. & Pasteels J. M. 1992, *Caste polyethism and collective defense in the ant, Pheidole pallidula: the outcome of quantitative differences in recruitment*. *Behav. Ecol. Sociobiol.* 29:405–412, DOI 10.1007/BF00170170 — (b), **TOOL**. Both castes cooperate in defence; defence strategies emerge from recruiters' elementary behaviour.

### 1.17 R267 (NEW) Wilson E. O. 1984, *The relation between caste ratios and division of labor in the ant genus Pheidole*. *Behav. Ecol. Sociobiol.* 16:89–98 — (b, several Neotropical spp.), **SEC** (via R261, R97, lecture notes)
- When minors are scarce, majors take up minor tasks ("emergency stand-by caste"); major:minor activity ratio varies with caste ratio (0.05–0.52 in *P. guilelmimuelleri*). R261 attributes part of this to sampling bias.
- Wilson 1985 *Behav. Ecol. Sociobiol.* 17:35–37 (*P. pubiventris*, DOI 10.1007/BF00299425; crossref metadata only): between-caste aversion as an alternative mechanism.

### 1.18 R268 (NEW) Bonabeau E., Theraulaz G. & Deneubourg J.-L. 1996, *Quantitative study of the fixed threshold model for the regulation of division of labour in insect societies*. *Proc. R. Soc. B* 263:1565–1569, DOI 10.1098/rspb.1996.0229 — (g, model), **TOOL**
- Castes with different fixed response thresholds reproduce Wilson's Pheidole results. Response function T(s) = s^n/(s^n + θ^n) (standard form of this model family; θ values are model, not data).

### 1.19 R174 Wheeler & Nijhout 1981 (*Science* 213:361, DOI 10.1126/science.213.4505.361) and 1984 (*J. Insect Physiol.* 30:127–135, DOI 10.1016/0022-1910(84)90116-1) — (b, *P. bicarinata*), **ABS** (1981 verified via Europe PMC; 1984 via publisher summary)
- 1981: JH analogue "during a period of sensitivity that occurs during the last larval instar"; "smallest size at which metamorphosis can be initiated is shifted upward from 1.2 to 1.7 millimeters".
- 1984: adult soldiers inhibit soldier development; inhibition also when soldiers are caged away from larvae, but stronger with more contact; high methoprene overrides it; proposed contact soldier pheromone shifting the JH threshold.

### 1.20 R269 (NEW) Wheeler D. E. & Nijhout H. F. 1983, *Soldier determination in Pheidole bicarinata: effect of methoprene on caste and size within castes*. *J. Insect Physiol.* 29:847–854, DOI 10.1016/0022-1910(83)90151-8 — (b), **TOOL** (publisher-page summary)
- Sensitive window ≈ days 4–6 of the final instar (at their rearing conditions). High doses delay metamorphosis and give large soldiers; the lowest effective dose speeds metamorphosis and gives small soldiers.

### 1.21 R212 Passera 1973; R175 Suzzoni, Passera & Strambi 1982; R213 Lillico-Ouachour 2017; R214 Rajakumar et al. 2018 — (b), from phase-3 notes (FULL/ABS there; not re-read)
- Honey-only colonies: 0 soldier pupae in 75 d (n = 4) vs 3.7–6.9 % soldier pupae with insects (n = 3); soldier larvae keep growing in L3 from 1.2 to 2.2–2.6 mm (no extra moult); larger larvae eat insect fragments.
- Soldiers only above 24 °C; protein required; after hibernation new soldiers only if adult soldiers < 5 %; dietary (not topical) JH raised soldier share; decision in L3 at ≈ 1.3 mm.
- Soldiers transmit inhibition by "selectively and passively contacting larvae" (thesis experiment).
- Social regulation of rudimentary wing-disc growth controls subcaste; R142 (Sameshima 2004) shows the same wing-disc pattern in *P. megacephala* (a).

### 1.22 R270 (NEW) Passera L., Roncin E., Kaufmann B. & Keller L. 1996, *Increased soldier production in ant colonies exposed to intraspecific competition*. *Nature* 379:630–631, DOI 10.1038/379630a0 — (b, *P. pallidula*), **TOOL**
- Colonies exposed to a rival colony produced more soldiers ("first experimental evidence" of adaptive caste-ratio adjustment). Secondary description: exposure through a mesh allowing antennal/leg contact. Opposite direction to R97's null result in *P. megacephala* across communities.

### 1.23 R271 (NEW) Lachaud J.-P., Passera L., Grimal A., Detrain C. & Beugnon G. 1992, *Lipid storage by major workers and starvation resistance in the ant Pheidole pallidula*. In Billen J. (ed.) *Biology and Evolution of Social Insects*, Leuven Univ. Press, pp. 153–160 — (b), **SEC** (via R261 and R116)
- Replete majors up to 32 % of majors; starvation resistance role.

### 1.24 R272 (NEW) Chown S. L., Marais E., Terblanche J. S., Klok C. J., Lighton J. R. B. & Blackburn T. M. 2007, *Scaling of insect metabolic rate is inconsistent with the nutrient supply network model*. *Funct. Ecol.* 21:282–290, DOI 10.1111/j.1365-2435.2007.01245.x — (g), **TOOL**
- Size-polymorphic workers of 8 ant species: intraspecific metabolic-rate scaling exponents 0.67–1.0.
- With a dry-mass ratio of 5.5, the major's resting metabolic rate would be 5.5^0.67 ≈ 3.1 to 5.5^1.0 = 5.5 × the minor's (my arithmetic; 一般生理學). *S. invicta* (R219 via phase-3 notes): large workers 0.9 vs small 1.55 µl O₂ h⁻¹ mg⁻¹ at 24 °C (non-species), i.e. lower mass-specific rate.

### 1.25 R273 (NEW) Mertl A. L., Sorenson M. D. & Traniello J. F. A. 2010, *Insectes Soc.* 57:441–452, DOI 10.1007/s00040-010-0102-5 — (b, ~20 Amazonian *Pheidole*), **TOOL**
- Across species, stronger recruiters have a higher proportion of majors at baits. Majors' bait presence is species-specific → not transferable.

### 1.26 R274 (NEW) Lin Minghui (undergraduate, supervisor B. Guénard), *The influence of caste ratio on the colony investment in the dimorphic ant Pheidole megacephala*. HKU Summer Research Fellowship poster F11 (undated, ~2021) — (a?), **FULL** (poster; grey literature, not peer-reviewed)
- Planned 40 wild nests (Hong Kong leaf litter) for a caste-ratio curve — **no field ratios reported**.
- Lab: 4 treatments × 10 replicates, 100 mg of workers with 0/10/20/30 % majors, 24 ± 1 °C, fish pellet 0.1 g, food weight loss after 3 h; ANOVA F = 106.1, p = 1.7 × 10⁻⁷; 30 % majors highest "foraging rate", 0 % lowest. Text mixes future and past tense; whether the experiment was done on *P. megacephala* is not explicit (Fig. 1 shows *P. braueri*). **Very low weight; validation only, qualitative.**

### 1.27 R275 (NEW) Creighton W. S. & Creighton M. P. 1959 (*P. militicida*), via AntWiki/search summary — (b), **SEC/TOOL**
- Lab colonies: majors, even in major-only nests, "never even attempted to open seeds". Used only to show seed milling is not a universal major function. R52 (Holley et al. 2016): seed-harvesting *Pheidole* majors do not have larger heads.

### 1.28 Other items checked
- Wetterer 2012 (R176): "soldiers crush seeds" without citation → no primary support.
- AntWiki "Repletes", thewildmartin.com care guide: non-primary, not used.
- keyapa.com blog (San Juan) on combat: non-peer-reviewed, not used.
- Hasegawa 1993 (*Colobopsis nipponicus*, DOI 10.1007/BF01242362): majors store food; different subfamily, not used.
- Yang et al. 2004 *Curr. Biol.* (*P. morrisi* geographic caste variation) and Yang 2006 (fat storage): SEC via R97/R116; not used numerically.
- No Chinese/Taiwanese primary study of *P. megacephala* caste ratio or major morphology found (one search, encyclopaedia/secondary hits only).
- Access failures: www.scifac.hku.hk direct curl reset (got the poster via WebFetch cache), Springer/Nature article pages redirect to login, Semantic Scholar 429.

---

## 2. Number classification (for the design)

| Quantity | Value | Class | Source |
|---|---|---|---|
| Major HW / minor HW | 1.10–1.54 / 0.50–0.61 mm | 文獻支持 (本種, museum) | R99 |
| Major:minor dry mass | 5.4–6.3 (4 pops), 11.4 (Australia) | 文獻支持 (本種; figure reading) | R97 |
| Major:minor fresh mass | 4.7 (1.65 vs 0.35 mg) | 文獻支持 (本種, Cameroon) | R98, R132 |
| Field major fraction | 0.06–0.25 (pop. means) | 文獻支持 (本種; sampling caveat) | R97 |
| Lab eclosion major fraction | 0.1186 (14/118) | 文獻支持 (本種, n small) | R94 |
| Crop load major:minor | 3.25 (0.26 vs 0.08 mg honey) | 文獻支持 (本種, carried load) | R132 |
| External droplet | ≈ 0.86 mg; total ≤ 1.88 mg | 文獻支持 (本種) | R132 |
| % soldiers among recruits, honey | 1.07 % neutral / 8.16 % marked | 文獻支持 (本種) | R132 |
| % soldiers among recruits, egg clusters | ≈ 28–32 % | 文獻支持 (本種; figure reading) | R98 |
| Survival 28 °C | mean 56 d, median 70 (n = 14) | 文獻支持 (本種) | R94 |
| Gompertz A, B majors | 0.0025, 0.044 d⁻¹ | 文獻支持 (fit of 本種 data; fit is ours) | R94 + phase-3 |
| Min. temperature for soldier production | 24 °C | 文獻支持 but 非本種 | R175 |
| Sensitive window | final instar (days 4–6 in *P. bicarinata*) | 非本種 | R174, R269 |
| Critical larval length | 1.2 → 1.7 mm (JH); P. pallidula ≈ 1.3 mm | 非本種 | R174, R175 |
| Major larva final length | 2.2–2.6 mm vs 1.2 mm | 非本種 | R212 |
| Metabolic scaling exponent | 0.67–1.0 | 一般生理學 (ants) | R272 |
| Starvation survival major/minor | ≈ 1.7–1.9 | 非本種 (*P. ryukyuensis*) | R260 |
| Major activity rate | 40–50 % vs minors ≈ 70 % | 非本種 (*P. pallidula*) | R261 |
| Response-threshold differences | qualitative + response table | 非本種 (*P. pallidula*) | R263–R265 |
| Major extra development time | null | — | — |
| Protein threshold for major path | null | — | — |
| Inhibition strength per major contact | null | — | — |
| Major nursing ability | null | — | (R136 suggests poor; R262 shows brood care in *P. pallidula*) |

## 3. Conflicts

1. **Storage role**: R132 intro, R176, R116 (genus-level statements) vs R260 ("*P. megacephala* apparently lacks repletes"). Only transport (crop + external droplet) is shown for *P. megacephala*.
2. **Stand-by caste**: R267 (Neotropical spp.) vs R261 (*P. pallidula*, stable activity; sampling-bias critique).
3. **Competition and caste ratio**: R270 (*P. pallidula* ↑ soldiers) vs R97 (*P. megacephala* ratio unrelated to community, but size related). R132: behavioural (recruitment-mix) response instead.
4. **Body mass**: Cameroon fresh 0.35 mg minors (R98) vs Okinawa ≈ 0.24 mg wet (R116); dry masses 63–97 µg (R97). Population variation is real (R97).
5. **Seed milling**: genus folklore (R132 intro, R176, R263 discussion) vs no *P. megacephala* data; R275 and R52 against a universal role.
6. **R173 repo summary** vs text (see 1.5).
7. **Brood care by majors**: *P. pallidula* majors do brood care (R262) vs *P. megacephala* queen + majors failed (R136; details to re-check).
8. **Soldier share outside the nest**: 1 % (honey) to 30 % (eggs) of recruits vs 6–25 % in nest samples: context-dependent, not a constant.
9. **R94** seasonal statement inconsistency (already recorded in phase 3).
10. **Methoprene dose** effects: delays (high dose) vs accelerates (low dose) metamorphosis (R269) → sign of major extra development time is not a constant even in *P. bicarinata*.
