# P0-A "24-hour ecological clock" — literature working notes (English)

Checked 2026-11-02. Research working notes, copied into the repo unchanged apart from this header and the downloads line (downloads are not committed). Existing IDs R1–R227 (R189–R203 on `phase2-behaviour`, R204–R227 on `phase3-lifecycle-design`). New IDs proposed here start at **R228**.
Access levels: FULL = full text read; ABSTRACT = abstract read verbatim from publisher/PubMed/AGRIS; SUMMARY = only via search/summary tool (not verbatim); SECONDARY = only cited by another paper.
Number classes: 文獻支持 (literature) / 一般生理學 (general physiology) / 遊戲假設 (game assumption). "非本種" = not *P. megacephala*.

Downloads were kept outside the repo; the AGRIS record of Castiñeiras (1982) was saved verbatim in the working folder and is summarised in §1.

---

## 1. TOP PRIORITY — Castiñeiras (1982)

**Citation (verified on AGRIS record 647245ed2c1d629bc9796862; old ID CU2003100082):**
Castiñeiras, A. (1982). Actividad forrajera de *Pheidole megacephala* (Hymenoptera: Formicidae: Myrmecinae). *Ciencia y Técnica en la Agricultura. Protección de Plantas* 5(3): 55–64. Spanish, summaries En/Es; "1 tab. 2 ilus. 16 ref." Affiliation: Instituto de Investigaciones de Sanidad Vegetal (INISAV), Havana, Cuba. No DOI.
URL: https://agris.fao.org/search/en/records/647245ed2c1d629bc9796862
- NOT Poeyana, NOT "Ciencias Biológicas". (Owner's guess was wrong on the journal.)
- AntCat/AntWiki/ResearchGate/CABI blocked (Cloudflare/403); AntCat author list does not seem to include Castiñeiras (author 12582 = Vázquez-Franco, not him).

**Access: ABSTRACT only (bilingual AGRIS abstract). Full text NOT obtained** — not digitised anywhere I could find (AGRIS has no PDF; SciELO Cuba/Redalyc don't cover 1982; Google Scholar/ResearchGate blocked).
→ Status label: 「已找到研究摘要，原始逐時數據未核實」.

**English abstract (verbatim from AGRIS):**
> "The use of ants as an element of biological control for pests is a common practice in Europe and America, essentially for the phytosanitary protection of forests. In Cuba, the ecology of the greatest part of our myrmecofauna is unknown, and the few existing results are limited to economically important species such as Atta insularis Guér. In order to obtain more ecological information for assessing the value of the bigheaded ant, Pheidole megacephala (Fabr.), as a predator on insect pests, its cycle of activity was studied troughout 1980. Observations were performed on a wild colony of hymenoptera at the base of a tree in the agricultural area of the Plant Protection Research Institute in Havana City. Once in a month, temperature, relative humidity, and the number of foraging ants on each of five fresh fish baits were recorded every two hours. Data analysis showed P. megacephala has a 24 hours cycle of activity closely, but not línearly, correlated with temperature and relative humidity. Foraging varied significantly for the month of the year, but not for the hour of the day. Ecuations which describe the activity of the workers in terms of temperature and relative humidity were determined."

Spanish abstract (verbatim, key part): "Una vez al mes se registraron, cada dos horas, la temperatura, la humedad relativa y el número de forrajeras que se encontraba sobre cada uno de cinco cebos a base de pescado fresco. El análisis de los datos nos permitió concluir que el ciclo de actividad de P. megacephala abarcaba las 24 horas del día y estaba estrechamente correlacionado, de manera no lineal, con la temperatura y la humedad relativa. El forrajeo varió significativamente entre los meses del año, pero no entre las horas del día. Se determinaron las ecuaciones que describen la actividad de las obreras en función de la temperatura y de la humedad relativa."

Extraction:
| Item | Value |
|---|---|
| Location | INISAV agricultural area, Ciudad de La Habana, Cuba (~23°N) |
| Dates/season | Throughout 1980, once per month (→ presumably 12 × 24-h sessions; number of sessions not stated) |
| Unit | ONE wild colony at the base of a tree |
| Method | 5 fresh-fish baits; count foragers on each bait (protein/lipid bait → biases toward protein foraging) |
| Interval | every 2 h (→ 12 slots/24 h) |
| Covariates | air temperature, RH at each count (light, rain: not mentioned) |
| Hourly pattern | Activity present in all 24 h; **hour-of-day effect NOT significant**; month effect significant |
| T/RH relation | "closely, but not linearly, correlated"; regression equations of activity on T and RH (equations NOT available) |
| Numbers | none in abstract |
| Not extrapolable | single colony; Havana climate (annual mean ~25 °C, warmer and more humid than Taichung 23.3 °C) — not verified in paper; fish bait; counts of ants at baits (activity density), not individual time budgets; whether bait counts were standing counts or cumulative not stated; "no hour effect" may be due to low power (n≈12 per slot) and pooling across months; correlation≠mechanism; the shape of the nonlinear function unknown. |

Interpretation for the model: supports (文獻支持, 本種, qualitative) that (i) workers can forage at any hour of the day/night in a warm-humid tropical lowland site; (ii) month/season (i.e., temperature/RH regime) explains more variance than clock time; i.e., there is no hard-wired diel time window. It does NOT give an activity curve.

Also found (not obtained): Castiñeiras & Brito (1983) on behaviour toward different baits (cited in CABI compendium); Castiñeiras et al. (1985) trap evaluation (AGRIS 647245ed2c1d629bc97968c1: largest colony catches in June/rainy season with banana-leaf traps, colonies ~60 000 individuals — not diel).

---

## 2. Other *P. megacephala* diel / climate sources

### R229 (new) Su, T.H. (1979) PhD thesis — FULL (scanned, ScholarSpace)
Su, Tsong Hong (1979). *The biology and control of the big-headed ant and its associated mealybugs in Hawaiian pineapple fields.* PhD dissertation, University of Hawaii (Dec 1979). University Microfilms 8012266. https://scholarspace.manoa.hawaii.edu/server/api/core/bitstreams/60860244-d33d-4c1c-8cbf-d329b4d885a8/content
- Section "b. The foraging activity of big-headed ant workers in relation to time of day" (pp. 37–41; Table 3, Fig. 8).
- Site: University of Hawaii at Manoa campus, Oahu; "heavily infested areas". Date of the diel test NOT stated (thesis fieldwork 1976–1979). No temperature recorded for this test.
- Method: baited wooden stakes (2 g peanut butter : soybean oil 50:50 on lower 15 cm); stakes placed for 2 h then counted; fresh stakes each interval; 08:30–22:30 (7 intervals); "Mean of four replicates in each test, two tests were carried out at the same time at two different locations." No samples 22:30–08:30.
- Results (mean ants/stake ± SE):

| Interval | Test 1 | Test 2 |
|---|---|---|
| 08:30–10:30 | 117.5 ± 60.35 a | 97.5 ± 24.11 ab |
| 10:30–12:30 | 105.3 ± 11.98 a | 60.3 ± 14.79 a |
| 12:30–14:30 | 100.8 ± 32.86 a | 58.3 ± 41.98 a |
| 14:30–16:30 | 97 ± 53.89 a | 55.3 ± 51.49 a |
| 16:30–18:30 | 192 ± 20.85 b | 115.5 ± 7.72 b |
| 18:30–20:30 | 223.8 ± 30.92 b | 127.5 ± 20.62 b |
| 20:30–22:30 | 222.5 ± 35.94 b | 155 ± 42.03 b |

  Author: workers foraged during the entire testing period; numbers "significantly greater after the 16:30–18:30 period … the greatest foraging activity … occurred after sunset." My calculation (not the author's): mean of the 3 evening slots / mean of 4 day slots ≈ 2.02 (Test 1) and ≈ 1.96 (Test 2).
- Also: soybean oil and PB:oil baits attracted more ants than honey water (Table 2; 17:00–20:00 test).
- Not extrapolable: Hawaii (Manoa: wet, mild); unknown season; lipid/protein bait; 2-h cumulative recruitment counts (not standing activity); no night-time after 22:30; no temperature data; quantitative ratio only for those two tests.
- Class: pattern = 文獻支持（本種，質性＋兩組數值）; the ~2× ratio is my derived summary — use only as validation pattern, not as a parameter.

### R167 (existing) Phillips (1933/1934) PhD thesis — FULL text re-read (ScholarSpace TEXT bundle)
New relevant passages (not in current R167 row):
- Field (Hawaiian pineapple fields, 1931–32): *Solenopsis geminata* "foragers were active during the warmest part of the day. Pheidole, on the other hand, was most active in the early mornings, the evenings and at night; it seems to avoid hot places as far as possible." (p. 146)
- "The effect of low winter temperatures is to suspend ant field activities at night, whereas in other seasons ants may be found tending mealy bugs during all hours." (p. 148) — context: Wahiawa, air minimum < 60 °F (15.6 °C) on some Jan–Feb nights; soil (2 in.) 62 °F (16.7 °C) "at which the ants are sluggish and nest life slows down".
- Lab gradual cooling (Jan 9, 1932; ~10 workers + 5 soldiers; flask): normal at 82–68 °F (27.8–20 °C); "rather sluggish" ~62 °F (16.7 °C); collapse at ~50 °F (10 °C); most recovered after rewarming (short exposure). n tiny; cooling rate minutes.
- Microclimate (Hagan 1931 via Phillips): uncovered soil at ¼ in. "frequently rose above 104 °F (40 °C) for two hours or more, except from December to April", while summer air max was 88 °F (31 °C) at Wahiawa; soil under plants much cooler. → direction + magnitude example for surface offset (sun-exposed bare soil ≫ air). Not P. megacephala data; it is a site microclimate measurement (secondary within Phillips).
- Constant 86 °F (30 °C) and 96 °F (35.6 °C) cabinets killed Pheidole colonies (already in R167).
- Humidity choice: of 39 fresh queens, 89% chose the 93% RH chamber (vs 63%, 33%, 10%) at ~80 °F, in darkness; all queens in 10% RH found dead. Queens, not workers.
- Nests "always found in damp places … wherever the moisture lingered longest"; colonies in lab died when water dried up.
- Ant-fence passage (p. 247; ants of pineapple fields, mainly but not exclusively P. megacephala): "as soon as the surface becomes damp … It is precisely at such times that ant movements are at their maximum. During the winter months … it usually rains during a portion of the night; in the early mornings before the sun dries it … foragers are particularly active at this time." → damp surface after rain ≠ suppression; species attribution uncertain.
- Heavy rains flood nests and drown inhabitants (p. 144–145; direct rain effect, nests near irrigation channels).
- Class: qualitative 文獻支持（本種）; temperature thresholds are tiny-n lab observations → 文獻支持 for direction only; values: low confidence.

### R166 (existing) Fluker (1969) PhD thesis — FULL text checked
No diel/hour-of-day activity observations found (grep for night/diurnal/sunset/a.m./p.m.). Only lab rearing at 20–22 °C (already R166), altitude limit "Pheidole was never found above the 3,000 feet level" (Hawaii), and rainfall/RH → mealybug fungal mortality. Nothing for P0-A.

### R189 (existing) Loke & Lee (2004) — still SUMMARY only
Loke, P.Y. & Lee, C.Y. (2004) Foraging behavior of field populations of the big-headed ant, *Pheidole megacephala*. *Sociobiology* 43(2): 211–219 (CABI: 211–220). Via search summary of a ResearchGate mirror: sampling only 08:00–16:00 in four intervals, 8 microhabitats (Penang); "bimodal peaks in morning hours (8 am – 12 pm)", reduced afternoon; marked decline in December (cooler). Full text not obtained (ResearchGate 403; lab page 404). Lee (2002, below) cites Loke (2002) BSc thesis as the underlying work. Keep R189 status "經摘要工具（未核實）"; add "daytime only, 08–16 h".

### R230 (new) Greenslade (1971) — SECONDARY
Greenslade, P.J.M. (1971) Interspecific competition and frequency changes among ants in Solomon Islands coconut plantations. *J. Appl. Ecol.* 8: 323–349(352). DOI 10.2307/2402874 (Crossref verified).
- Chong & Lee (2009, R232) cite it as classifying *P. megacephala* (and *Iridomyrmex cordatus*, *Solenopsis saevissima*, *Camponotus melanoticus*) as **nocturnal**, *Oecophylla smaragdina* as diurnal. I did not read Greenslade. Class: secondary qualitative (本種), unverified.

### R145 / R146 (existing) — unchanged; used as validation patterns (see design §9).

### Searched, nothing new found
- Chinese/Taiwanese (熱帶大頭家蟻／热带大头蚁 活動節律): nothing species-specific beyond R145/R177.
- Yuan et al. (2026) *Insects* 17:992 (life history, China) — MDPI 403; abstract-level summary mentions seasonal caste production only; not diel. Not used.
- Hoffmann, Andersen & Hill (1999) *Oecologia* 120:595 — seasonal range expansion/contraction (wet vs dry season), not diel. Not used here.
- Dejean et al. (2007) *C R Biol* 330:701 — FULL PDF grep: no diel data.
- Brazil: none found.

---

## 3. Mechanisms (other species, all 非本種 unless stated)

### R231 Lee (2002) ICUP proceedings — FULL
Lee, C.Y. (2002) Tropical household ants: pest status, species diversity, foraging behavior, and baiting studies. In Jones, Zhai & Robinson (eds) *Proc. 4th Int. Conf. Urban Pests*, pp. 3–18. https://icup.org.uk/media/newnzwle/icup200.pdf
- *Paratrechina longicornis*, *Monomorium pharaonis*, *Solenopsis geminata* (非本種) on a building corridor, Penang; baited index cards every 2 h continuously up to 48 h; counts ~30 min after placement; 3 replicates (alternate weeks).
- Peak 2–4 h after sunset (~22:00); activity "gradually ceased at about 15:00"; negatively correlated with ambient temperature; outdoor ~25 °C night vs ~33 °C (max 35) day.
- Pheidole sp. (big-headed ant, presumably P. megacephala) was among the commonest household ants but **not** included in the diel test.
- Supports: tramp myrmicines in hot tropical lowland can be night-shifted; temperature-limited daytime foraging. Values non-extrapolable.

### R232 Chong & Lee (2009) — FULL
Chong, K.-F. & Lee, C.-Y. (2009) Influences of temperature, relative humidity and light intensity on the foraging activity of field populations of the longlegged ant, *Anoplolepis gracilipes*. *Sociobiology* 54(2): 531–539.
- 9 field populations, USM Penang; sugar/prawn/egg-yolk baits on trails; photos every 2 h for 72 h (hourly 18–20 h and 06–08 h).
- Activity at all hours; day 1 no pattern; days 2–3 more foragers at night; peak 10:00; lowest 14:00–16:00 (highest T, lowest RH); highest activity 26–30 °C.
- Regression: T r² = 0.2025 (negative slope), RH r² = 0.2105 (positive), light r² = 0.0731 (P = 0.0795, n.s.).
- Supports: temperature/humidity explain only ~20% each → large residual variance (other factors: recruitment, food, colony state); light not a gate for this tramp ant. 非本種.

### R233 Cassill, Brown, Swick & Yanev (2009) — FULL
*J. Insect Behav.* 22: 313–323. DOI 10.1007/s10905-009-9173-4. *Solenopsis invicta* (非本種), ONE lab colony subset (3 queens, 30 workers, 30 larvae) in an artificial chamber, 27 °C, ~50% RH, 14:10 LD, video 4.7 days.
- Workers: ~253 sleep episodes/day × ~1.1 min ≈ 4.8 h sleep/day; queens ~92 × ~6 min ≈ 9.4 h.
- ~20% of workers asleep at any time; fewer asleep 06–14 h than 14–22 h; activity episodes unaffected by light/dark; worker cycles polyphasic and asynchronous; sleep bout duration depends on location (floor 32.8 s, ceiling 82.1 s, wall 108.7 s) — workers in traffic disturbed more.
- Deep sleep: antennae folded, non-responsive to contact.
- Supports: rest = many short asynchronous bouts, interruptible by contacts, location-dependent; not a single nightly block. Values: 非本種, tiny sample → model rest parameters stay null / 遊戲假設.

### R234 Hasegawa et al. (2016) — ABSTRACT
Hasegawa E., Ishii Y., Tada K., Kobayashi K., Yoshimura J. (2016) Lazy workers are necessary for long-term sustainability in insect societies. *Sci. Rep.* 6: 20846. DOI 10.1038/srep20846.
- Simulation + colony evidence: variable response thresholds create inactive workers that replace fatigued active workers; colonies with variable thresholds persist longer. Species not named in abstract (paper uses *Myrmecina nipponica*, not verified here).
- Supports: fatigue/rest-debt + threshold variability as a mechanism. No usable values.

### R235 Cole (1991) — SUMMARY (abstract-level; DOI verified)
Cole, B.J. (1991) Short-term activity cycles in ants: generation of periodicity by worker interaction. *Am. Nat.* 137: 244–259. DOI 10.1086/285156. *Leptothorax allardycei* (非本種): colony activity periodic (~26 min mean); workers activate each other by contact; larger groups → more regular peaks.
- Supports: contact-triggered activation (event-driven re-evaluation) and spontaneous activation; the period is NOT a parameter for us.

### R236 Mildner & Roces (2017) — ABSTRACT
*PLoS ONE* 12: e0169244. DOI 10.1371/journal.pone.0169244. *Camponotus rufipes* (非本種). Isolated foragers and nurses: circadian locomotor rhythms (mostly nocturnal under 12:12 LD). In colony: most foragers synchronised to time-restricted food (day or night); nurses active around the clock without circadian pattern; nurses rhythmic again when isolated.
- Supports: (i) nest workers effectively arrhythmic in social context; (ii) foragers' timing can be entrained by when food is available (non-photic zeitgeber) — i.e., an individual memory of "when food was found" is biologically plausible.

### R237 Ingram, Krummey & LeRoux (2009) — ABSTRACT
*BMC Ecol.* 9: 7. DOI 10.1186/1472-6785-9-7. *Pogonomyrmex occidentalis* (非本種): foragers show strong daily cycling of *period* and diurnal activity; nest workers show continuous low-level activity without strong cycling; seasonal phase shift.
- Supports: task-dependent rhythmicity (foragers rhythmic, nest workers continuous).

### R238 Sharma, Lone, Goel & Chandrashekaran (2004) — ABSTRACT
*Naturwissenschaften* 91: 386–390. DOI 10.1007/s00114-004-0544-6. *Camponotus compressus* (非本種), individuals in LD/DD: majors nocturnal; ~75% media nocturnal, ~25% diurnal; minors neither entrained nor free-running.
- Supports: inter-individual/caste variation in rhythm; some castes arrhythmic. No values for us.

### R239 Narendra, Reid & Hemmi (2010) — ABSTRACT
*Proc. R. Soc. B* 277: 1531–1538. DOI 10.1098/rspb.2009.2324. *Myrmecia pyriformis* (非本種): foraging onset at a specific ambient light intensity in evening twilight (not a temperature, not a clock time); experimentally confirmed.
- Supports: light can be a gate for SOME species. Contrast with R232 (light n.s. for *A. gracilipes*) and R233 (fire-ant activity unaffected by LD). → For P. megacephala light gating is unknown: default light factor = 1 (night allowed; Owner decision), day-only only as control.

### R240 Jeanson & Weidenmüller (2014) — ABSTRACT
*Biol. Rev.* 89: 671–687. DOI 10.1111/brv.12074. Review: consistent inter-individual variability; sources: genetic, maturational, nutritional, environmental, social feedback, learning; most work on threshold variability; probability and intensity of response under-studied.
- Supports: per-individual thresholds AND per-individual response probability/intensity as separate state variables.

### R241 Gordon, Dektar & Pinter-Wollman (2013) — ABSTRACT
*PLoS ONE* 8: e63363. DOI 10.1371/journal.pone.0063363. *Pogonomyrmex barbatus* (非本種): 94 trials, 17 colonies, 3 years; effect of returning foragers on outgoing rate increases with humidity; consistent colony differences.
- Supports: humidity modulates the response to a local signal (returning foragers), i.e., desiccation cost enters the departure decision as a multiplier on local stimulus.

### R242 Bujan, Yanoviak & Kaspari (2016) — ABSTRACT
*Ecol. Evol.* 6: 6282–6291. DOI 10.1002/ece3.2355. 82 Panama ant species: desiccation resistance 0.7–97.9 h; increases with body mass; canopy vs understory VPD 0.43 vs 0.05 kPa.
- Supports: small workers desiccate fast; VPD (not RH alone) as the driver → use VPD from T and RH. Pair with R154 (本種: LT50 10.8 h at ~55% RH, 3.9 h at ~7% RH).

### R243 Kaspari & Weiser (2000) — ABSTRACT (first page of PDF)
*Biotropica* 32: 703–711. DOI 10.1111/j.1744-7429.2000.tb00518.x. Panama rainforest ant community at baits: +25% activity dry→wet season; "Activity varied little from day to night"; desiccation risk and food as likely causes. 非本種 (community).
- Supports: in humid tropics, day–night differences can be small (consistent with R145 forest, Castiñeiras).

### R244 Dolai, Soltani, Smarr & Das (2024) — ABSTRACT
*J. Biol. Rhythms* 39: 295–307. DOI 10.1177/07487304241233778. *Oecophylla smaragdina* (非本種), 9 nests, hourly nest entries: rainy days significantly fewer entries (p<0.0001); rain "masks" (suppresses) the rhythm, which reverts quickly after rain, no compensatory foraging afterwards; diurnal predation → phase inversion to nocturnal.
- Supports: rain = suppression while it lasts (masking), quick return; no catch-up assumed.

### R245 Farji-Brener et al. (2018) — SUMMARY (DOI verified)
*Insectes Soc.* 65: 233–239. DOI 10.1007/s00040-018-0605-z. *Atta cephalotes* (非本種): wetting increased leaf-load mass by 143%; wet loads and wet ants drop loads; simulated humidity + raindrop noise → ants speed up ~30%.
- Supports: rain affects individuals and loads directly (mechanism direction); values not transferable.

### R246 Human et al. (1998) — SUMMARY (DOI verified)
*Environ. Entomol.* 27: 822–833. DOI 10.1093/ee/27.4.822. *Linepithema humile* + natives, Jasper Ridge: daily activity analysed vs soil T, air T, RH; large overlap. Mechanism only; no values used.

### R247 Parton & Logan (1981) — bibliographic only (DOI verified; not read)
*Agric. Meteorol.* 23: 205–216. DOI 10.1016/0002-1571(81)90105-9. "A model for diurnal variation in soil and air temperature": sine by day, exponential decay by night. Use as the method reference; its fitted coefficients NOT read → keep null until the paper is read.

### Already in repo, re-used
R2 (Das & Gordon 2023 rhythms), R17 (Myrmecia temperature schedules), R18 (fire-ant circadian foraging), R35 (pheromone decay vs temperature), R106 (Temnothorax reserve workers), R145, R146, R151 (>50% inactive), R154 (desiccation LT50, 本種), R190–R202 (P. pallidula curves, task switching, Detrain & Pasteels thresholds, Sempo & Detrain active fractions, Charbonneau inactive individuals).

---

## 4. Synthesis for the clock (what the evidence does and does not say)

1. P. megacephala diel pattern is **context dependent**, never "day-only":
   - Taichung urban (Mar): daytime peak 12–15 h, lower but nonzero night (R145).
   - Taichung forest (May): ~flat day/night (R145).
   - Havana (all year, 1 colony): activity in all 24 h, hour effect n.s., month effect sig. (Castiñeiras, abstract).
   - Hawaii Manoa (unknown season): evening/after-sunset ≈ 2× daytime at baits, 08:30–22:30 only (Su 1979).
   - Hawaii pineapple fields (1930s): early morning, evening, night; avoids heat; winter cold suppresses night activity (Phillips).
   - W. Australia (autumn/spring, day only): morning > afternoon (R146).
   - Penang (day only, 08–16 h): morning peaks, December decline (R189, summary).
   - Solomon Is.: "nocturnal" (Greenslade via R232, secondary).
   → The species avoids hot/dry surface conditions and cold nights; otherwise forages around the clock. This is exactly a temperature/humidity-gated, clock-free model, with night allowed (Owner decision). The variety of shapes is itself a validation target: one parameter set should be able to produce daytime-peak in cool months and evening/night-peak on hot sunny days, by environment alone.
2. No study measured **individual** activity budgets of P. megacephala (all are bait/trap counts = activity density). Rest/sleep/fatigue parameters: only non-本種 (R233, R234, R151, R197).
3. Light: unknown for P. megacephala; mixed across species (R239 vs R232/R233). Default no light gate.
4. Rain: no P. megacephala data on foraging during rain. Phillips: damp surfaces after night rain = high movement; floods drown nests. Non-本種: rain suppresses foraging while it lasts (R244, R245). → departure suppression during rain = 遊戲假設 with 非本種 direction support; post-rain wet surface: no suppression (Phillips direction).
5. Humidity/desiccation: R154 gives 本種 LT50 under two RH levels → upper bound on safe exposure; R241/R242 support VPD-modulated departure. Thresholds = 遊戲假設.
6. Temperature: hard limit CTmax 42/44 °C (R145); low-temperature sluggish ~16–17 °C and collapse ~10 °C (Phillips, tiny n, 本種, low confidence); P. pallidula curve (R190, 非本種). Activity-suppression thresholds remain null (scenario-tested).
