"""Phase 3 arithmetic: compare development models to P. megacephala datasets, and lifespan curves.
Only numbers typed in by hand from the notes are used (no downloaded file is read)."""
import math

# ---------------- development datasets (egg, larva[incl. prepupa], pupa, total) ----------------
# T is the representative temperature (midpoint of stated range); see notes.md for provenance.
D = [
    # name, T, Tlo, Thi, egg, larva, pupa, total, kind
    ("Fluker1969 (R166)", 21.0, 20.0, 22.0, 21.0, 30.0, 21.0, 72.0, "range midpoints 19-23/28-32/19-23; total 66-78"),
    ("Phillips1933 C (R167)", 23.6, 22.8, 24.4, 18.0, 27.0, 20.5, 65.5, "class mean, indoor uncontrolled"),
    ("Phillips1933 B (R167)", 25.6, 24.4, 26.7, 17.0, 23.5, 19.0, 59.5, "class mean"),
    ("Phillips1933 A (R167)", 27.0, 26.7, 27.2, 12.0, 20.0, 20.0, 52.0, "class mean"),
    ("Chang1985 (R136)", 26.5, 26.0, 27.0, 8.5, 16.5, 9.0, 36.0, "'average minimum'; majority/most values; total 34-38"),
    ("Yuan2026 (R94)", 28.0, 27.0, 29.0, 7.69, 15.99, 5.05, 28.73, "mean, n=52 adults"),
]
STAGES = ["egg", "larva", "pupa", "total"]

def engine_factor(T, q10=1.55, ref=25.0, lo=0.48, hi=1.9):
    return min(hi, max(lo, q10 ** ((T - ref) / 10)))

ENGINE = {"egg": 10.0, "larva": 12.0, "pupa": 10.0}
ENGINE["total"] = sum(ENGINE.values())

def linfit(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx; a = my - b * mx
    return a, b

def dd_from(points):
    """rate = (T - T0)/K ; fit rate = a + bT ; T0=-a/b ; K=1/b"""
    a, b = linfit([p[0] for p in points], [1 / p[1] for p in points])
    return -a / b, 1 / b

def q10_fit(points, ref=25.0):
    """ln(D) = ln(D25) - (T-ref)/10 * ln(Q10)"""
    a, b = linfit([(p[0] - ref) / 10 for p in points], [math.log(p[1]) for p in points])
    return math.exp(a), math.exp(-b)

idx = {"egg": 4, "larva": 5, "pupa": 6, "total": 7}
print("=== Engine (Q10 1.55, ref 25, clamp 0.48-1.9; egg10/larva12/pupa10) vs data ===")
print(f"{'dataset':26s} {'T':>5s} " + " ".join(f"{s+'_obs':>9s} {s+'_eng':>9s}" for s in STAGES))
for r in D:
    f = engine_factor(r[1])
    print(f"{r[0]:26s} {r[1]:5.1f} " + " ".join(f"{r[idx[s]]:9.2f} {ENGINE[s]/f:9.2f}" for s in STAGES))

sets = {
    "Fluker+Chang+Yuan": [0, 4, 5],
    "Fluker+Yuan": [0, 5],
    "Phillips A-C only": [1, 2, 3],
    "all six": [0, 1, 2, 3, 4, 5],
}
print("\n=== Linear degree-day fits (rate=(T-T0)/K) per stage ===")
fits = {}
for nm, ii in sets.items():
    for s in STAGES:
        pts = [(D[i][1], D[i][idx[s]]) for i in ii]
        T0, K = dd_from(pts)
        D25, Q = q10_fit(pts)
        fits[(nm, s)] = (T0, K, D25, Q)
        print(f"{nm:20s} {s:6s} T0={T0:6.2f} K={K:7.1f} DD | Q10-fit: D25={D25:6.2f} Q10={Q:5.2f}")

print("\n=== Predictions of the Fluker+Chang+Yuan DD fit and Q10 fit, per dataset (total) ===")
T0, K, D25, Q = fits[("Fluker+Chang+Yuan", "total")]
for r in D:
    T = r[1]
    dd = K / (T - T0) if T > T0 else float('inf')
    qq = D25 / Q ** ((T - 25) / 10)
    print(f"{r[0]:26s} T={T:5.1f} obs={r[7]:6.2f} DD={dd:6.2f} Q10fit={qq:6.2f} engine={ENGINE['total']/engine_factor(T):6.2f}")
print("Extrapolation (Fluker+Chang+Yuan total):")
for T in [15, 17, 18, 19, 20, 22, 24, 25, 30, 32]:
    dd = K / (T - T0) if T > T0 else float('inf')
    qq = D25 / Q ** ((T - 25) / 10)
    print(f"  T={T:4.1f}  DD={dd:8.1f}  Q10fit={qq:7.1f}  engine={ENGINE['total']/engine_factor(T):6.1f} (factor {engine_factor(T):.3f})")

print("\n=== Pairwise Q10 (total) ===")
for i in range(len(D)):
    for j in range(i + 1, len(D)):
        a, b = D[i], D[j]
        if abs(a[1] - b[1]) < 0.5: continue
        q = (a[7] / b[7]) ** (10 / (b[1] - a[1]))
        print(f"  {a[0]:24s} vs {b[0]:24s} Q10={q:5.2f}")

print("\n=== Stage proportions (egg:larva:pupa of total) ===")
for r in D:
    print(f"  {r[0]:26s} egg {r[4]/r[7]:.2f} larva {r[5]/r[7]:.2f} pupa {r[6]/r[7]:.2f}")

# Engine factor clamp interplay
print("\nEngine factor at 10..35 C:", [(T, round(engine_factor(T), 3)) for T in range(10, 36, 5)])
print("Temp where clamp 0.48 binds: T =", 25 + 10 * math.log(0.48) / math.log(1.55))
print("Temp where clamp 1.90 binds: T =", 25 + 10 * math.log(1.9) / math.log(1.55))

# Fluctuating-temperature illustration (Jensen): mean 21 C, +/-5 C sinusoid, linear DD with T0
def mean_rate_sin(Tm, A, T0, K, n=2400):
    s = 0.0
    for k in range(n):
        T = Tm + A * math.sin(2 * math.pi * k / n)
        s += max(0.0, T - T0) / K
    return s / n
T0, K = fits[("Fluker+Chang+Yuan", "total")][:2]
for Tm in [16, 18, 21, 25]:
    for A in [0, 3, 5]:
        r = mean_rate_sin(Tm, A, T0, K)
        print(f"Fluct (DD, T0={T0:.1f}) Tmean={Tm} amp={A}: days={1/r if r>0 else float('inf'):7.1f}")

# ---------------- lifespan ----------------
print("\n=== Yuan 2026 Table S3 (28 C) interval hazards ===")
days = [0, 14, 28, 42, 56, 70, 84, 98]
minor = [104, 73, 35, 24, 9, 1, 1, 0]
sold = [14, 12, 11, 11, 8, 6, 1, 0]
for nm, N in [("minor", minor), ("soldier", sold)]:
    hs = []
    for k in range(len(days) - 1):
        if N[k] > 0 and N[k + 1] > 0:
            h = math.log(N[k] / N[k + 1]) / 14
        else:
            h = float('nan')
        hs.append(h)
    print(nm, "S:", [round(n / N[0], 3) for n in N], "daily hazard per interval:", [round(h, 4) for h in hs])
    # mean lifespan, deaths at interval midpoints
    m = sum((N[k] - N[k + 1]) * (days[k] + 7) for k in range(len(days) - 1)) / N[0]
    print(f"  mean lifespan (death at interval midpoint) = {m:.1f} d")

def gompertz_ll(A, B, N):
    ll = 0.0
    def S(a): return math.exp(-A / B * (math.exp(B * a) - 1))
    for k in range(len(days) - 1):
        d = N[k] - N[k + 1]
        p = S(days[k]) - S(days[k + 1])
        if d > 0: ll += d * math.log(max(p, 1e-300))
    return ll
for nm, N in [("minor", minor), ("soldier", sold)]:
    best = None
    for i in range(1, 200):
        A = i * 0.0005
        for j in range(0, 200):
            B = 0.0005 + j * 0.0005
            ll = gompertz_ll(A, B, N)
            if best is None or ll > best[0]: best = (ll, A, B)
    ll, A, B = best
    S = lambda a: math.exp(-A / B * (math.exp(B * a) - 1))
    mean = sum(S(a / 10) for a in range(0, 3000)) / 10
    med = next(a / 10 for a in range(0, 5000) if S(a / 10) <= 0.5)
    print(f"Gompertz MLE {nm}: A={A:.4f}/d B={B:.4f}/d  mean={mean:.1f} median={med:.1f}  S(14,28,56)={S(14):.2f},{S(28):.2f},{S(56):.2f}")

# Engine natural hazard (temperature-independent): h=0.003+0.00075*max(0,a-28)
S = 1.0; mean = 0.0; med = None; s_at = {}
for a in range(0, 2000):
    h = 0.003 + 0.00075 * max(0, a - 28)
    h = min(h, 0.98)
    mean += S
    S *= (1 - h)
    if med is None and S <= 0.5: med = a + 1
    if a + 1 in (14, 28, 56, 70, 84, 98, 140): s_at[a + 1] = round(S, 3)
print(f"Engine natural hazard: mean lifespan {mean:.1f} d, median {med} d, S at {s_at}")
print("Ratio engine mean / Yuan minor mean 26.25 =", round(mean / 26.25, 2), "; / Yuan all 29.78 =", round(mean / 29.78, 2))

# S. invicta longevity (Porter & Tschinkel 1985, 30 C): y = 39 + 55*HW
for hw in [0.6, 0.8, 1.0, 1.2, 1.4]:
    print(f"S. invicta 30C mean longevity at head width {hw} mm = {39+55*hw:.0f} d")
print("Calabi&Porter: +14% per 2C drop => Q10 =", round(1.14 ** 5, 2))

# Taichung monthly mean air temperature prior used by the repo world model (CWA normals as prior; nest temp != air temp)
print("\n=== Egg->adult (minor) at Taichung monthly mean AIR temperature (illustration only; nest temp unknown) ===")
months = [17.0, 17.7, 20.1, 23.5, 26.4, 28.1, 28.9, 28.4, 27.8, 25.5, 22.6, 18.7]
T0, K, D25, Q = fits[("Fluker+Chang+Yuan", "total")]
T0p, Kp, D25p, Qp = fits[("all six", "total")]
for i, T in enumerate(months, 1):
    dd = K / (T - T0) if T > T0 else float('inf')
    ddp = Kp / (T - T0p) if T > T0p else float('inf')
    qq = D25 / Q ** ((T - 25) / 10)
    print(f"  month {i:2d} T={T:4.1f}  engine={ENGINE['total']/engine_factor(T):5.1f}  DD(F+C+Y)={dd:7.1f}  DD(all6)={ddp:7.1f}  Q10fit={qq:6.1f}")
