# Phase 3 literature notes: brood development vs temperature, worker/queen mortality, queen laying cycles, oophagy and brood nutrition (P. megacephala)

Checked 2026-11-02 (research working notes, copied into the repo unchanged apart from this header; downloaded files are not committed). Text was extracted with `pdftotext` or a small XML-to-text script. Model arithmetic is in `fits.py` (this folder), and its output is in `fits-output.txt`. That script uses only numbers typed in by hand from these notes.

This note builds on four earlier working notes (Day0, WP2, WP4 and Phase 2 literature checks; their conclusions are in `docs/references.md`, the notes themselves are not in the repo) without repeating them; labels F1–F10 and S1–S11 refer to those notes. Sources already read there are summarised here only where Phase 3 needs them. New reads are marked **NEW**.

Read-status codes:
- **FULL**: the full text was read by me.
- **FULL-PART**: the full text was in hand, but only the relevant sections were read.
- **ABS**: the abstract only.
- **IMG**: a scanned page was rendered to an image and read visually (no text layer).
- **TOOL**: read through a summarising tool (WebSearch/WebFetch summary), so the wording is not verified line by line.
- **SEC**: known only through a citing paper.

Class codes:
- (a) *P. megacephala*
- (b) other species, named (「非本種」)
- (g) general physiology or method

---
## A. Development vs temperature

### A1. Yuan, Nong, Qin & Gao 2026. R94 (a). FULL (Europe PMC XML + supplementary xlsx, parsed again here: `txt/yuan_supp.txt`)
- *Insects* 17(10):992, DOI 10.3390/insects17100992, PMC13705411.
- **Conditions:** Nanning (Guangxi) population. Lab at 28 ± 1 °C, 70 ± 5 % RH, 16L:8D. Food: mealworms + 10 % sucrose/agar with vitamins. Eggs from all queens over 24 h, after which the queens were removed and ~100 workers added (§2.2).
- **Development (mean ± SD, days from oviposition):**

  | Event | Day |
  |---|---|
  | Hatch | 7.69 ± 0.63 (7–9); 89.03 % hatched (227/255) |
  | L2 | 9.54 |
  | L3 | 15.06 |
  | Prepupa onset | 21.13 ± 2.57 (n = 93); prepupal period 2.55 ± 0.19 |
  | Pupation | 23.68 ± 2.38 (n = 80); pupa 5.05 ± 0.45 (n = 52) |
  | Adult (non-reproductives) | **28.73 ± 2.83** (range 24–34) |

  - Larva including prepupa: 15.99 d.
  - Reproductives: prepupa 4.16, pupa **12.31**, egg→adult **37.60 ± 3.20**.
  - Minors and soldiers are pooled. "Non-reproductive third-instar larvae fed for approximately six further days".
- **Not interpretable as survival:** the counts 194 → 93 → 80 → 52.
- **Queens and pulsed laying:** "Field and laboratory colonies contained multiple dealate, oviposition queens (polygyny). Oviposition was pulsed rather than continuous. A queen laid a batch of eggs over a short period, then paused until that brood approached the prepupal stage before resuming egg laying" (§3.5). This is a qualitative observation; no counts are given.
- **Egg cannibalism:** "only 38% of eggs developed into larvae because workers and young larvae consumed many of them, whereas most eggs hatched in our queen-separated cohorts, which suggests that egg cannibalism within intact colonies, rather than low intrinsic egg viability, limits the conversion of eggs into brood" (Discussion, citing Chang).
- **Seasonality:**
  - "only worker-destined brood found through winter and early spring, whereas soldier- and reproductive-destined brood appeared from late spring onwards and sexuals were most frequently encountered between March and May, with males more numerous than gynes."
  - The Simple Summary says "reared soldiers and reproductives mainly from late spring to autumn". **Internal inconsistency** with "most frequent March–May".
- **Longevity (Table S3, re-parsed; census every 14 d, 28 °C, ad lib):**
  - Minors (n = 104): 104, 73, 35, 24, 9, 1, 1, 0 at days 0, 14, …, 98.
  - Soldiers (n = 14): 14, 12, 11, 11, 8, 6, 1, 0.
  - Reported: mean minors 26.25, soldiers 56; KM median 28 vs 70. The text says "last minor died at day 84", but Table S3 still has 1 minor alive at d84 → inconsistency.
  - Soldiers made up 11.86 % at eclosion (14/118).
- **My arithmetic (fits-output.txt):**
  - Interval daily hazard, minors: 0.025 (0–14), 0.053, 0.027, 0.070, 0.157 (56–70).
  - Interval daily hazard, soldiers: 0.011, 0.006, 0, 0.023, 0.021, 0.128.
  - Gompertz MLE (interval-censored, grid): minors A = 0.0245/d, B = 0.020/d (mean 26.0, median 22.5); soldiers A = 0.0025/d, B = 0.044/d (mean 56.5, median 58.7).
  - These are my fits, not the authors'. The sample is small (14 soldiers).
- **Limits:** one population, one temperature, lab, ad lib. Queen lifespan was not measured.

### A2. Chang 1985. R136 (a). FULL (re-checked the Day0 working note text of Chang 1985)
- *Proc. Hawaiian Entomol. Soc.* 25:53–58.
- **Conditions:** 26–27 °C, 50 % RH, 8 h light. Single mature field queen in small revival nests. Honey-water + artificial diet ~2×/week.
- **Development (minor workers):**
  - Eggs: "Eggs took 6 to 11 days to hatch with the majority hatching at 7 to 10 days".
  - Larvae: "9 to 21 days … most requiring 16 to 17 days".
  - Pupae: "7 to 11 days".
  - Total: "A generation of minor workers took 34 to 38 days".
  - These are "average minimum" times (mixed cohorts). Chang mentions a "fourth instar", whereas Yuan reports 3 instars.
- **Fecundity:**
  - "The queen deposited eggs in groups consisting of 2 to 82 eggs per group on random days. The interval between egg-laying could last up to 8 days. In 31 days, a queen laid from 97 to 292 eggs, averaging 6 eggs per queen per day."
  - "some were eaten by newly hatched larvae or workers in the nest. In our test, only 38% of the eggs turned to larvae."
- **Limits:** n is not given for the development values. Queens were mature, not founding queens. Small nests.

### A3. Phillips 1933. R167 (a). FULL (see earlier WP4 working note F2)
- **Conditions:** 22 lab colonies (1–2 queens, 25–100 workers + soldiers), uncontrolled indoor temperatures. Monthly means 73–81.5 °F. Inspected twice weekly, fed weekly.
- **Class means (days):**

  | Class | Temperature | Egg | Larva | Pupa | Total |
  |---|---|---|---|---|---|
  | A | ≥26.7 °C | 12 | 20 | 20 | 52 |
  | B | 24.4–26.7 | 17 | 23.5 | 19 | 59.5 |
  | C | ≤24.4 (≈22.8–24.4) | 18 | 27 | 20.5 | 65.5 |

- **Other findings:**
  - Several broods died.
  - Larval stage lengthened by food shortage at 25 °C: 2-week starvation → 32–36 d. After 3 weeks unfed, larvae were not full-grown at 38 d and pupated 8 d after refeeding.
  - Constant 30 °C killed 1–2 small colonies (queen dead day 4–5 and 21); 35 °C killed all in 2–5 d.
  - Nests ≤100 individuals produced only minors. Sexual brood appeared only in "strong, well-established" nests.

### A4. Fluker 1969. R166 (a). FULL (see earlier WP4 working note F1)
- **Conditions:** air-conditioned lab at 20–22 °C. One queen + 15–20 workers; the queen was removed after 30–50 eggs.
- **Ranges:** egg 19–23, larva 28–32, pupa 19–23, egg→adult 66–78. n is not given and the meaning of "range" is undefined.

### A5. Porter 1988. R168 (b, *Solenopsis invicta*). TOOL (abstract via search) + SEC (Porter & Tschinkel 1993 and Cassill & Tschinkel 2000, both FULL in WP4)
- Minor egg→adult 55 d at 24 °C, 23 d at 35 °C. "17 °C theoretical minimum"; colony growth ceased below 24 °C. Stage proportions are independent of temperature.
- My linear fit from the two endpoints: T0 ≈ 16.1 °C, K ≈ 436 DD.

### A6. Porter & Tschinkel 1993, *BES* 32:321–329. **New ID proposed** (b, *S. invicta*). FULL (WP4)
- "A 1 °C shift in brood temperature from 31 °C to 30 °C would decrease developmental rates by about 7%".
- "Each 2 °C drop in temperature should increase the longevity of workers by about 14% (Calabi and Porter 1989)".
- Colony growth is maximal at ~32 °C.

### A7. Cassill & Tschinkel 2000, *J Insect Physiol* 46:933–939. **New ID proposed** (b, *S. invicta*). FULL (WP4)
- 25 °C is the lowest temperature at which brood can be successfully reared, and no sexuals were produced at 25 °C.
- Larval duration and growth rate scale together, so pupal size is unaffected by temperature.

### A8. Abril, Oliveras & Gómez 2010. R169 (b, *Linepithema humile*). FULL (WP4)
- Egg 58 d at 18 °C, <15 d at 30 °C.
- Pupa ~25 d at 21 °C, ~8 d at 30 °C.
- No egg survived at 32 °C; <2 % hatched at 18 °C.
- The Hartley & Lester 2003 degree-day model ("445 DD > 15.9 °C") is SEC only; the threshold value is NOT verified (a search on 2026-11-02 again did not surface it).

### A9. Kipyatkov & Lopatina 2015. R170 (b/g, 33 spp). ABS
- Development rate is linear in temperature over the mid-range (TTD, SDD).
- TTD and SDD are negatively correlated.
- Not known whether *Pheidole* is included.

### A10. **NEW** Brière, Pracros, Le Roux & Pierre 1999, *Environ. Entomol.* 28(1):22–29, DOI 10.1093/ee/28.1.22 (g). ABS (via search tool + R `devRate` documentation)
- Brière-1 model: r(T) = a·T·(T − Tmin)·(Tmax − T)^{1/2}. Brière-2 replaces the exponent with 1/b.
- The model has 3–4 parameters. Equation 1 gave better threshold estimates.
- **Not fitted here.** With *P. megacephala* data only between 21 and 28 °C and none above the optimum, Tmax is not identifiable.

### A11. **NEW** Colinet, Sinclair, Vernon & Renault 2015, *Annu. Rev. Entomol.* 60:123–140, DOI 10.1146/annurev-ento-010814-021017 (g). ABS (TOOL)
- Moderate fluctuations within permissive ranges generally benefit performance. Fluctuations into stressful temperatures can help (repair) or harm (cumulative damage).
- Nonlinear rate curves mean that the outcome at a fluctuating temperature differs from the outcome at the constant mean (Jensen's inequality).
- The core.ac.uk PDF returned 403.

### A12. **NEW** Tschinkel 1993b, *Ecol. Monogr.* 63:425–457 ("Sociometry and sociogenesis … during one annual cycle"), JSTOR copy at bio.fsu.edu/~tschink/publications/1993-6.pdf (b, *S. invicta*). FULL-PART (abstract, methods on pupal development, discussion)
- **Field pupal period:** this method is useful for us. It assumes pupae sit at the preferred 31 °C if available, otherwise at the warmest available temperature below 31 °C, and that "development did not proceed below 24 °C (Porter 1988)". The hourly rate fraction is summed over the daily nest-temperature profile. This is an example of integrating a rate model over fluctuating temperature together with brood relocation.
- **Annual cycle:**
  - "Production rates peaked in spring, with colonies investing 50% of their daily production in sexuals."
  - "The percent of annual production invested in sexuals increased sharply in colonies of between 20 000 and 50 000 workers, then remained at 33%".
- **Majors and worker lifespan:**
  - The percent of major workers increased with colony size.
  - Worker turnover was ">600%/yr in small colonies to ~270% in large colonies, implying an increase in mean worker life span from ≈2 mo to 4½ mo" (field, all sizes pooled).

### A13. **NEW** Penick & Tschinkel 2008, *Insectes Soc.* 55:176–182 (approx.), DOI 10.1007/s00040-008-0987-4 (b, *S. invicta*). FULL-PART (abstract)
- Brood is moved up to sun-heated mound layers in the morning, and moved down "when temperatures exceed optimal (~32 °C)".
- Relevance: brood temperature ≠ mean nest temperature where ants can choose their position. There are no *P. megacephala* data, and *P. megacephala* does not build mounds (R94).

### A14. Sexual vs worker and major vs minor durations
- **Yuan:** sexual pupa 12.31 vs worker 5.05 at 28 °C (ratio 2.44). Sexual egg→adult 37.6 vs 28.73.
- **Majors:** no species-specific duration.
  - *P. pallidula* (b), Passera 1973 (C2 below): soldier larvae are larvae that keep growing past the 1.2 mm worker pupation size to 2.2–2.6 mm in the same (3rd) instar.
  - *P. bicarinata* (b), Wheeler & Nijhout 1981 (R174): methoprene shifts the minimum size for metamorphosis from 1.2 to 1.7 mm. Lillico-Ouachour 2017 (C3) adds that it "delays metamorphosis by several days".
  - So a major larval period = minor + extra (null).

---
## B. Adult mortality and lifespan

### B1. Yuan 2026 R94. See A1 (the only *P. megacephala* worker lifespan data; 28 °C only).

### B2. GISD "78 d at 21 °C / 38 d at 27 °C" lifespans: rejected
- See earlier WP4 working note F3. These are almost certainly the development times of Fluker and Chang mislabelled as lifespans. Excluded for that stated reason.

### B3. **NEW** Porter & Tschinkel 1985a, *Behav. Ecol. Sociobiol.* 16:323–336 ("Fire ant polymorphism: the ergonomics of brood production"), PDF bio.fsu.edu/~tschink/publications/1985-1.pdf (b, *S. invicta*). FULL
- **Longevity:** callow workers wire-marked and kept in queenright lab colonies at **30 ± 0.5 °C**.
  - Fig. 6 (p. 331, page image checked): mean longevity = **39 + 55 × head width (mm)**, R² = 61.2 %. Each point is the mean of 10–20 workers, from 5 colonies.
  - Gives ≈72 d at 0.6 mm and ≈116 d at 1.4 mm. Point range ≈45–130 d.
  - "Large workers lived about 50% longer than small workers"; "intercolony differences strongly affected worker longevity".
- **Brood rearing:**
  - Colonies of only large workers "produced little or no brood". Large workers inhibited larval development and reduced the queen's oviposition rate.
  - Smaller colonies produced ~2× more brood per gram of workers.
  - Respiration per mg decreased ~40 % with size.
- **Limits:** other genus; 30 °C only; lab. It shows that size-dependent longevity ratios exist in a dimorphic/polymorphic myrmicine. It also shows that Yuan's 2.1× (mean) soldier/minor ratio is larger than the S. invicta size effect, which is a continuous polymorphism.

### B4. Calabi & Porter 1989. R171 (b, *S. invicta*). TOOL/SEC
- **NEW secondary (FULL):** Kramer & Schaible 2013 *PLoS ONE* 8:e61813 (PMC3626611) states:
  - "Large workers live 50% longer than minors in treatments with 24°C".
  - Respiration at 24 °C: 0.9 vs 1.55 µl O₂ h⁻¹ mg⁻¹ (large vs small).
  - "The large workers only forage for the last 25% of their lives, whereas small and medium-sized individuals do so for about 50% at the end of their lives" (citing Calabi & Porter).
- **Combined with Porter & Tschinkel 1993:** each 2 °C drop → +14 % longevity, so Q10(lifespan) ≈ 1.14⁵ ≈ **1.93** (my arithmetic).
- Absolute values at 24 °C are still NOT obtained (Elsevier paywall; no repository copy found).

### B5. Giraldo et al. 2016. R172 (b, *P. dentata*). TOOL (WebFetch of PMC4721105; Europe PMC/NCBI efetch returned only the front matter)
- **Quotes via tool:**
  - "Workers reared in our queenright subcolonies live up to 140 days".
  - "Laboratory mortality of minors is 50% at 77 days and 25% at 117 days, with a maximum lifespan of 140 days."
  - The wording is ambiguous; it is most likely 50 % survivorship at 77 d and 25 % at 117 d.
- **Conditions:** 25 °C, 40–55 % RH, subcolonies started from 40–70 pupae. Majors were not measured.
- **Comparison:** 77 d median vs *P. megacephala* 28 d at 28 °C. The 3 °C difference alone cannot explain this ratio under any Q10 below ~30. It is a species difference (or a methodological one).

### B6. **NEW** Asano & Cassill 2012, *J. Theor. Biol.* 305:70–77 (b, *S. invicta*, model). ABS (USF repository page via WebFetch)
- Simulation: "longer worker lifespans there [at lower temperatures] partly offset the reduced egg production and slower development".
- Model, not data.

### B7. **NEW** Kramer & Schaible 2013 (above) and Jaimes-Nino & Oettler 2025, *Biol. Rev.* (PMC12407051), DOI 10.1111/brv.70035 (g/b). FULL-PART
- **Queen lifespan data are of poor quality.**
  - Keller & Genoud 1997 compared queen lifespans of 37 monogynous vs 6 polygynous species: "mean ± SD 12.3 ± 5.5 versus 1.6 ± 1.8 years". The review calls these "questionable" ("low replicate numbers").
  - *Cardiocondyla obscurior* (polygynous tramp myrmicine): queen mean 0.5 y, max 0.9 y (n = 99).
  - Worker lifespans in the literature are often not from age-controlled cohorts.
- **Other proxies for queen lifespan in polygynous tramps:**
  - *Wasmannia auropunctata* queens in polygynous lab colonies: 13.0 ± 1.8 months (Ulloa-Chacón & Cherix 1989, R163, FULL in WP2).
  - *M. pharaonis* ~200 d (Edwards via R163, SEC).
- *P. megacephala* queen lifespan: **no data** (Yuan: not measured).

### B8. High-temperature adult mortality (a)
- **Chronic, Phillips 1933 (R167):** at constant 30 °C, small colonies died within 16–21 d (n = 1–2). Conflicts with Yuan's successful 28 ± 1 °C rearing.
- **Acute:**
  - LT50 for 1 h: 34.6 °C (WA dry) to 44.6 °C (Qld moist) (R146, Asfiya 2016).
  - Taichung CT about 42–44 °C (R145).
- No dose-time model links these.

---
## C. Queen laying, reproductive cycles, polygyny

### C1. Chang 1985 (A2) and Yuan 2026 (A1)
- The only *P. megacephala* queen-laying data: batches, gaps of up to 8 d, 97–292 eggs/31 d, and pausing until the brood nears prepupa.
- **Conflict:** Chang's gaps are ≤ 8 d, whereas Yuan's pause lasts until the brood nears prepupa (≈ 21 d at 28 °C).

### C2. **NEW** Passera 1973, "Origine des soldats dans les sociétés de *Pheidole pallidula*", Proc. VII IUSSI Congress, London, pp. 305–? (b). FULL (PDF scan with text layer; dictionnaire-amoureux-des-fourmis.fr)
- See D below; listed here because the colonies with insect protein also grew far more.

### C3. **NEW** Vargo 1989, *Actes Coll. Insectes Sociaux* 5:109–116 (b, *S. invicta*). FULL (OCR text)
- **Design:** lab colonies (75 g workers + 25 g brood) given 2–256 dealate queens. Twelve field colonies had 70.9 ± 54.0 queens (5–186).
- **Results:**
  - "Fecundity (oviposition rate) is related negatively to the number of resident queens".
  - Mean queen weight = 11.41 + 40.66/N (field, R² 0.88) and 10.62 + 16.32/N (lab, R² 0.78).
  - Eggs in a 5-h test = −169.77 + 18.07 × queen weight (mg) (R² 0.57).
  - "the effect of increasing queen number is strongest when queen number is low (< 50)".
  - Uninseminated queens make up up to 50 % of egg-layers and are 5–25 % less fecund.
  - Cites Vargo & Fletcher 1989 *Physiol. Entomol.* 14:223–232 (NOT read).
- **Limits:** different genus. Fire-ant queens lay hundreds of eggs per day; *P. megacephala* queens lay ~3–9 per day (Chang).

### C4. **NEW** Tschinkel 1988, *Physiol. Entomol.* 13:327–350 (b, *S. invicta*). IMG (abstract pages 327–328 rendered and read; the rest of the scan not read)
- "Workers and pupae do not stimulate oviposition by queens. The number of fourth instar larvae … bears a positive log–log relationship to the queen's egg-laying rate."
- Withdrawing 4th instars: "within 48 h, … a decline in queen oviposition almost to zero". Adding them back: "peak laying in about 4 days".
- When larvae are fed dye, it "is rapidly transferred to worker crops, and into the queen's eggs, indicating bulk movement of material from larvae to workers to the queen and eggs".
- "Fourth instar larvae may be a digestive and metabolic caste that processes protein for egg production by the queen."
- Large workers transmit the larval stimulation less well. Worker age has no effect.
- The introduction (p. 328) cites Brian 1957b: in *Myrmica rubra*, peaks in the standing crop of eggs resulted from **oophagy by newly hatched larvae** (SEC).

### C5. **NEW** Tschinkel 1995, *Ann. Entomol. Soc. Am.* 88:876–882 (b, *S. invicta*). IMG (page 1)
- "Meconial-stage brood stimulated queens to lay eggs 60–170% faster than the other stages".
- "a certain group of workers repeatedly collects an unknown material from the anus of pharate pupae and proceeds more or less directly to the queen retinue, where they offer trophallactic exchange to the queen."
- Lab at 30 °C.
- **Mechanistic parallel to Yuan's "pause until brood approaches prepupal stage":** the meconium is voided at the prepupal transition.

### C6. Ulloa-Chacón & Cherix 1989. R163 (b, *Wasmannia*). FULL (WP2)
- The opposite sign to C4/C5: young larvae (L2) suppress laying (3.5 vs 10.2 eggs/d). Prepupae and pupae have no effect.
- Queen age: 6.0, 12.0 and 4.7 eggs/d at 2, 5 and 10 months.

### C7. **NEW** Tschinkel 1993a, *Behav. Ecol. Sociobiol.* 33:209–223, JSTOR copy bio.fsu.edu/~tschink/publications/1993-4.pdf (b, *S. invicta* founding queens). FULL-PART
- Per-queen production declines as a negative exponential with queen number. Brood attrition is strong during the larval period: "44% larval attrition even in solo queen nests", reaching "88% attrition in 10-queen nests"; "most of the brood reduction was due to other causes, probably cannibalism".
- "Cannibal queens lost much less weight to produce a given number of minims", i.e. nutrients are recycled.
- **Worker size:** citing Porter & Tschinkel 1985b, "when a fixed number of workers was allowed to rear larger numbers of larvae, the resulting pupae were smaller".
- **Limits:** claustral founding (not budding). Different genus.

### C8. **NEW** Bar, Shalev & Scharf 2022, *Biology* 11:1714 (PMC9774527) (b, *Cataglyphis niger*). ABS
- Decreasing temperature impaired egg laying much more than shortening daylength, and the effect was rapidly reversible on warming.
- Direction only: temperature-gated laying.

### C9. Sexual production season / colony size
- **(a) Yuan:** sexuals mostly March–May (Nanning); none in winter/early spring.
- **(a) Phillips:** only in strong nests.
- **(b) S. invicta:** spring, colony-size threshold of 20 000–50 000 workers (Tschinkel 1993b), no sexuals at 25 °C (Cassill & Tschinkel 2000).
- **(b) P. pallidula:** lab colonies skip the sexual phase in 25–50 % of years (Passera & Suzzoni 1984, WP2).
- **Florida P. megacephala:** flights in winter and spring per UF/IFAS (R95, TOOL).
- A Murdock & Tschinkel 2015 *Insectes Soc.* 62:265–280 (*P. morrisi* annual cycle, DOI 10.1007/s00040-015-0403-9) result is NOT read (AntWiki 403, Springer 429). Only an S2 TLDR was obtained, so it is not used.

---
## D. Caste (major) determination by nutrition; brood nutrition, culling, oophagy

### D1. **NEW** Passera 1973 (b, *Pheidole pallidula*). FULL
- **Larval stages:** larval development has 3 instars fed by regurgitation.
  - L3 is 0.60–1.20 mm long. Worker larvae pupate at 1.20 mm.
  - Soldier larvae keep growing in L3 to 2.20–2.60 mm without an extra moult.
  - "seules les plus grosses [larves] consomment de minces débris de proies … ces larves carnivores mesurent toutes plus de 1.20 mm."
  - The author concludes: "Le soldat semble donc résulter d'un déterminisme trophique".
- **Experiment:** 7 colonies, each with 1 queen and 270 workers + 25–30 soldiers (≈10 %), followed for 75 days (temperature not stated in this abstract-length paper).
  - **Honey + insects (n = 3):** end workers 1334 / 2564 / 1517, soldiers 62 / 146 / 50 (4.4 / 5.4 / 3.2 %). Pupae: workers 541 / 563 / 473, soldiers 21 / 41 / 35 (3.7 / 6.8 / 6.9 %).
  - **Honey only (n = 4):** end workers 43 / 72 / 51 / 127, soldiers 8 / 13 / 21 / 16. Pupae: workers 3 / 18 / 12 / 22, **soldiers 0**.
  - "Les nids nourris de miel pur n'ont produit aucun soldats".
- **Note:** the honey-only colonies also collapsed in total numbers (270 → 43–127 workers). Protein limits all brood production, not only soldiers.

### D2. Suzzoni, Passera & Strambi 1982. R175 (b, *P. pallidula*). FULL (WP4)
- Soldiers are produced only above 24 °C. Protein-rich food is required. After hibernation, new soldiers appear only if adult soldiers are <5 %.
- Dietary JH raised the soldier share. Topical JH failed. Determination occurs in L3 at ~1.3 mm.

### D3. **NEW** Lillico-Ouachour 2017, MSc thesis, McGill University ("The behavioural, chemical, and morphological basis of caste regulation in the worker caste of ants"), handle 20.500.14905/110925 (b, *Pheidole* review + experiments). FULL-PART (text bitstream; ch. 1 review = Lillico-Ouachour & Abouheif 2017, *Curr. Opin. Insect Sci.* 19:43–51)
- **Switches:** sex is set by haplodiploidy. The queen–worker switch is JH-mediated and "season-dependent". The soldier–minor switch is JH-mediated and "largely influenced by nutrition; a protein-rich diet activates JH production to prolong development and induce the soldier program" (citing Goetsch 1937, Passera 1974, Wheeler & Nijhout 1981, 1983).
- **Soldier inhibition:**
  - "increasing the proportion of soldiers decreases soldier production" (Gregg 1942; Passera 1974).
  - Wheeler & Nijhout 1984 compared high (40 soldiers + 40 minors) with low (20 + 40) contact; caged soldiers still suppressed.
  - Soldiers "rear 100% of brood through to adulthood".
- **The thesis's own experiment:** soldiers transmit the inhibitory signal "by selectively and passively contacting larvae". Candidate: cuticular alkanes.
- **McGlynn & Owen 2002** (*Insectes Soc.* 49:8–14, *P. flavens*, Costa Rica field) is SEC via this thesis: protein supplementation "increased the number of soldier pupae … especially when food was supplemented in a clumped manner".
- **Other secondary items:**
  - Johnston & Wilson 1985: elevated temperature increases soldier production in the lab.
  - Wills et al. 2014 (R97): *P. megacephala* soldier proportion is not correlated with competitive environment.

### D4. Wheeler & Nijhout 1981/1984. R174 (b, *P. bicarinata*). ABS
- A JH analogue in the last-instar sensitive period induces soldiers; the minimum metamorphosis size shifts from 1.2 to 1.7 mm.
- Soldier contact suppresses soldier induction.

### D5. **NEW** Rajakumar et al. 2018, *Nature* 562:574–577, DOI 10.1038/s41586-018-0613-1 (b, *Pheidole* spp.). ABS (Europe PMC)
- Growth of rudimentary wing discs is necessary for soldier head/body allometry.
- "Pheidole colonies have evolved the capacity to socially regulate the growth of rudimentary wing discs to control worker subcaste determination, which allows these colonies to maintain the ratio of minor workers to soldiers."
- **Related (a):** Sameshima et al. 2004 (R142) report the same wing-disc pattern in *P. megacephala*.

### D6. **NEW** Huang, Wheeler & Fjerdingstad 2013, *Mol. Ecol.* 22, DOI 10.1111/mec.12218 (b, *Pheidole*). ABS
- "their workers lack ovaries and are thus invariably sterile".
- So any trophic eggs in *Pheidole* must be queen-laid. *P. megacephala* worker ovaries were not checked directly.

### D7. Passera 1978 via Genzoni et al. 2023 supplement. R164 (b, *P. pallidula*)
- Trophic eggs are laid only by virgin queens.
- **Not found:** any record of trophic eggs in *P. megacephala*.

### D8. **NEW** Sorensen, Busch & Vinson 1983, *J. Kansas Entomol. Soc.* 56(2):140–150 (b, *S. invicta*). TOOL (abstract via search summary)
- Cannibalism was highest on an oil + egg-yolk diet and lower with insects/honey.
- Cannibalism rose and pupation fell when workers were starved, or when CO₂ was used for counting.
- Baseline cannibalism in insect-fed colonies ≈ 8–13 %.
- This identifies the "unattributed snippet" in the earlier WP2 working note. Numbers come via a summarising tool, so re-verify before any use.

### D9. **NEW** Schultner, Gardner, Karhunen & Helanterä 2014, *Am. Nat.* 184:E161, DOI 10.1086/678459 (b, 8 *Formica*-group spp.). ABS
- Larvae cannibalise eggs. Cannibalism is lower when nestmate relatedness is higher, and it differs by larval sex.
- Schultner, Oettler & Helanterä 2017 *Q. Rev. Biol.* 92:39–78 (DOI 10.1086/690840): a review of brood roles. NOT read.

### D10. **NEW** Warner, Lipponen & Linksvayer 2017, bioRxiv 211573 (b, *Monomorium pharaonis*). ABS (preprint)
- Caste allocation is regulated by culling very young reproductive-destined larvae. Workers "make decisions about culling larvae based on the ratio of the number of workers to the number of eggs … likely signalled by pheromone present on eggs".
- Caution: the worker:egg ratio is a colony-level quantity. Only a local encounter-based version would satisfy repo rule 2.1.

### D11. **NEW** Cassill & Tschinkel 1995, *Anim. Behav.* 50:801–813 (b, *S. invicta*). FULL-PART (abstract + intro)
- "workers feed larvae the same, small increment of liquid food, regardless of larval attributes"; "The rate of trophallaxis increased with larval food deprivation".
- Hungry large larvae are fed at higher rates: "13 feedings for each µl of larval volume". Larvae need about 8 h of feedings to reach satiation.
- Feeding rate is independent of neighbouring larvae's hunger, encounter rate, position and orientation. "an individual larval hunger cue directs the feeding of each larva."
- This is a local mechanism that fits rule 2.1.

### D12. **NEW** Cassill & Tschinkel 1999, *Insectes Soc.* 46:261–266 (b, *S. invicta*). FULL-PART (abstract)
- Colony size (100–10 000) and worker:brood ratio (1:1–16:1) did not affect the rate or duration of larval feeding.
- "Only when the worker:brood ratio was less than 1, were larvae tended or fed at reduced rates."
- "social feeding in the fire ant emerges from localized interactions rather than mass communication."

### D13. Dussutour & Simpson 2009. R112/R203 (b; the species is not named in the abstract). ABS (Europe PMC, verified)
- "processing excess protein shortened life span—an effect that was greatly ameliorated in the presence of larvae."
- The amount and balance of nutrients collected depend on the presence of larvae.

### D14. Phillips 1933 (A3) (a)
- Larval duration is food-dependent: food reduction or starvation lengthens the larval period, and larvae resume after refeeding.
- Workers killed soldiers in small colonies "but not … eat them". Wheeler cites *P. militicida* workers killing soldiers in winter when food is short (SEC).

### D15. Tsuji 1990 (b, *P. ryukyuensis*). TOOL (WP4)
- Replete majors. Minors with a distended major survived ~4× longer under starvation. A possible major food-storage role; not for *P. megacephala*.

---
## E. Access failures (2026-11-02)
- core.ac.uk PDFs: 403 (Colinet 2015, Schultner core copies).
- Springer article pages: HTTP 429 (Murdock & Tschinkel 2015, McGlynn & Owen 2002).
- Semantic Scholar API: empty responses for most DOIs (rate limit).
- AntWiki: 403.
- Elsevier (Calabi & Porter 1989, Porter 1988, Asano & Cassill 2012): paywalled; the USF repository has the abstract only.
- *Physiol. Entomol.* Vargo & Fletcher 1989: not accessible.
- Tschinkel 1988/1995 and Porter & Tschinkel 1985b (1985-3.pdf), 1987 (queen longevity, 1987-2.pdf): scans without a text layer. No OCR tool is available. Only the pages rendered as images (abstracts) were read.
- ARS Porter publication page: 404.
- Chinese/Taiwanese thesis on 熱帶大頭家蟻／热带大头蚁 development vs temperature: none found (two searches; results were encyclopaedia pages only).
- Hartley & Lester 2003 threshold value: not verified.
