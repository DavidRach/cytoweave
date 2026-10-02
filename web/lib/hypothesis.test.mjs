import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjustPValues,
  blockAnova,
  arcsineSqrt,
  binomialGLM,
  bootstrap,
  chiSquareCDF,
  chiSquareSurvival,
  chiSquareTest,
  cohensD,
  designMatrix,
  differentialAbundance,
  erf,
  erfc,
  fCDF,
  fisherExact,
  foldChange,
  friedmanTest,
  fSurvival,
  gammaP,
  gammaQ,
  hodgesLehmann,
  incompleteBeta,
  incompleteBetaComplement,
  kruskalWallis,
  linearRegression,
  logGamma,
  logit,
  mannWhitneyU,
  normalCDF,
  normalQuantile,
  oneWayAnova,
  pairedTTest,
  pearsonCorrelation,
  rank,
  spearmanCorrelation,
  studentTCDF,
  studentTQuantile,
  studentTTest,
  tTest,
  welchAnova,
  welchTTest,
  wilcoxonSignedRank,
} from './hypothesis.js';
import { createRandom } from './random.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}
function rel(actual, expected, tolerance, message = '') {
  close(actual, expected, tolerance * Math.abs(expected), message);
}

// R's `sleep` data (Cushny & Peebles): extra sleep under drug 1 and drug 2, same 10 patients.
const drug1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0];
const drug2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];

// Closed forms of the t CDF for df = 1…4 (Abramowitz & Stegun 26.7.3–4).
const tCdfExact = {
  1: (t) => 0.5 + Math.atan(t) / Math.PI,
  2: (t) => 0.5 + t / (2 * Math.sqrt(t * t + 2)),
  3: (t) => {
    const u = t / Math.sqrt(3);
    return 0.5 + (Math.atan(u) + u / (1 + u * u)) / Math.PI;
  },
  4: (t) => {
    const th = Math.atan(t / 2);
    return 0.5 + (Math.sin(th) / 2) * (1 + Math.cos(th) ** 2 / 2);
  },
};

test('log-gamma matches exact values', () => {
  close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-15);
  close(logGamma(10), Math.log(362880), 1e-13);
  close(logGamma(3.5), Math.log(1.875 * Math.sqrt(Math.PI)), 1e-14);
  close(logGamma(0.1), 2.252712651734206, 1e-13); // ln Γ(0.1), Γ(0.1) = 9.513507698668732
  let lf = 0;
  for (let k = 2; k <= 100; k += 1) lf += Math.log(k);
  rel(logGamma(101), lf, 1e-14, 'ln 100!');
});

test('incomplete gamma matches Poisson sums and the exponential', () => {
  for (const [a, x] of [[1, 0.3], [1, 7], [3, 2.5], [5, 3.7], [12, 20], [50, 45], [50, 70]]) {
    // P(a, x) = 1 − e^{−x} Σ_{k<a} x^k / k! for integer a.
    let term = Math.exp(-x);
    let sum = term;
    for (let k = 1; k < a; k += 1) {
      term *= x / k;
      sum += term;
    }
    rel(gammaQ(a, x), sum, 1e-12, `Q(${a}, ${x})`);
    close(gammaP(a, x) + gammaQ(a, x), 1, 1e-15);
  }
  close(chiSquareCDF(3, 2), 1 - Math.exp(-1.5), 1e-15, 'χ²₂ CDF');
  close(chiSquareSurvival(3.841458820694124, 1), 0.05, 1e-14, 'qchisq(0.95, 1) = 1.95996²');
  rel(chiSquareSurvival(100, 2), Math.exp(-50), 1e-13, 'far tail');
});

test('incomplete beta satisfies its identities and the binomial relation', () => {
  for (const [x, a, b] of [[0.3, 2, 5], [0.7, 0.5, 0.5], [0.01, 10, 3], [0.999, 4, 40], [0.5, 30, 70]]) {
    close(incompleteBeta(x, a, b), 1 - incompleteBeta(1 - x, b, a), 1e-14, 'reflection');
    close(incompleteBeta(x, a, b) + incompleteBetaComplement(x, a, b), 1, 1e-15);
  }
  close(incompleteBeta(0.37, 1, 1), 0.37, 1e-15);
  close(incompleteBeta(0.37, 3, 1), 0.37 ** 3, 1e-15);
  close(incompleteBeta(0.37, 1, 4), 1 - 0.63 ** 4, 1e-15);
  close(incompleteBeta(0.5, 7.3, 7.3), 0.5, 1e-13, 'symmetric');
  // I_p(k, n − k + 1) = P(Binomial(n, p) ≥ k).
  const n = 10;
  const p = 0.3;
  let below = 0;
  let c = 1;
  for (let j = 0; j < 3; j += 1) {
    below += c * p ** j * (1 - p) ** (n - j);
    c = (c * (n - j)) / (j + 1);
  }
  close(incompleteBeta(p, 3, 8), 1 - below, 1e-14);
});

test('normal distribution matches R', () => {
  close(normalQuantile(0.975), 1.959963984540054, 1e-14);
  close(normalCDF(1.959963984540054), 0.975, 1e-15);
  rel(normalCDF(-1), 0.15865525393145705, 1e-14); // pnorm(-1)
  rel(normalCDF(-5), 2.866515718791939e-07, 1e-13); // pnorm(-5)
  rel(normalCDF(-10), 7.619853024160527e-24, 1e-13); // pnorm(-10)
  close(erf(1), 0.8427007929497149, 1e-15);
  rel(erfc(3), 2.209049699858544e-05, 1e-13);
  for (const p of [1e-12, 1e-5, 0.01, 0.3, 0.5, 0.77, 0.999]) rel(normalCDF(normalQuantile(p)), p, 1e-13, `round trip ${p}`);
});

test('Student t distribution matches closed forms and R', () => {
  close(studentTQuantile(0.975, 10), 2.228138851986274, 1e-13); // qt(0.975, 10)
  for (const df of [1, 2, 3, 4]) {
    for (const t of [-30, -4.2, -1, -0.1, 0.5, 2, 12]) {
      close(studentTCDF(t, df), tCdfExact[df](t), 1e-14, `pt(${t}, ${df})`);
    }
    for (const p of [0.001, 0.05, 0.4, 0.975, 0.9999]) {
      const q = studentTQuantile(p, df);
      close(tCdfExact[df](q), p, 1e-13, `qt(${p}, ${df})`);
    }
  }
  // Far tail keeps relative precision: P(T₁ > 1e6) = atan(1/1e6)/π.
  rel(studentTCDF(-1e6, 1), Math.atan(1e-6) / Math.PI, 1e-12);
  close(studentTQuantile(0.975, Infinity), 1.959963984540054, 1e-14);
  // Huge df approaches the normal: needs log-beta without cancellation (R's lbeta method).
  // First-order expansion F_ν(t) = Φ(t) − φ(t)(t³ + t)/(4ν) + O(ν⁻²) (Abramowitz & Stegun 26.7.5).
  const phi = (t) => Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);
  close(studentTCDF(1.5, 1e9), normalCDF(1.5) - (phi(1.5) * (1.5 ** 3 + 1.5)) / 4e9, 1e-14);
  rel(studentTCDF(-6, 1e7), normalCDF(-6) - (phi(-6) * (-216 - 6)) / 4e7, 1e-9);
  for (const df of [2.5, 7, 33.3, 400]) {
    for (const p of [1e-8, 0.025, 0.6]) rel(studentTCDF(studentTQuantile(p, df), df), p, 1e-12, `round trip df ${df}`);
  }
});

test('F distribution matches t² and the closed form for (2, d)', () => {
  for (const [t, df] of [[1.3, 4], [2.9, 10], [0.2, 25]]) {
    close(fSurvival(t * t, 1, df), 2 * studentTCDF(-t, df), 1e-14, 'F(1, ν) = t²');
  }
  // P(F₂,d > f) = (1 + 2f/d)^(−d/2).
  close(fSurvival(27, 2, 6), 0.001, 1e-16);
  close(fCDF(3, 2, 2), 3 / 4, 1e-15);
});

test('t-tests reproduce R on the sleep data', () => {
  // t.test(extra ~ group, data = sleep): t = -1.8608, df = 17.776, p-value = 0.07939,
  // 95 percent CI -3.3654832 0.2054832.
  const welch = welchTTest(drug1, drug2);
  close(welch.statistic, -1.8608, 5e-5);
  close(welch.df, 17.776, 5e-4);
  close(welch.p, 0.07939, 5e-6);
  close(welch.ci[0], -3.3654832, 5e-8);
  close(welch.ci[1], 0.2054832, 5e-8);
  // var.equal = TRUE: t = -1.8608, df = 18, p-value = 0.07919, CI -3.363874 0.203874.
  const student = studentTTest(drug1, drug2);
  assert.equal(student.df, 18);
  close(student.p, 0.07919, 5e-6);
  close(student.ci[0], -3.363874, 5e-7);
  close(student.ci[1], 0.203874, 5e-7);
  // paired = TRUE: t = -4.0621, df = 9, p-value = 0.002833, CI -2.4598858 -0.7001142.
  const paired = pairedTTest(drug1, drug2);
  close(paired.statistic, -4.0621, 5e-5);
  close(paired.p, 0.002833, 5e-7);
  close(paired.ci[0], -2.4598858, 5e-8);
  close(paired.ci[1], -0.7001142, 5e-8);
  assert.equal(tTest(drug1, drug2, { paired: true }).p, paired.p);
  // One-sided p is half the two-sided one when the effect is in the tested direction.
  close(welchTTest(drug1, drug2, { alternative: 'less' }).p, welch.p / 2, 1e-15);
  assert.throws(() => welchTTest([1, 1, 1], [2, 2, 2]), /constant/);
});

test('ANOVA and Welch ANOVA', () => {
  // Groups (1,2,3), (4,5,6), (7,8,9): SSB = 54, SSW = 6, F = 27 on (2, 6), p = (6/60)³ = 0.001.
  const anova = oneWayAnova([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  close(anova.statistic, 27, 1e-12);
  close(anova.p, 0.001, 1e-15);
  close(anova.etaSquared, 0.9, 1e-15);
  // With two groups Welch's ANOVA is the Welch t-test: F = t², same denominator df.
  const welch = welchAnova([drug1, drug2]);
  const t = welchTTest(drug1, drug2);
  close(welch.statistic, t.statistic ** 2, 1e-12);
  close(welch.df2, t.df, 1e-10);
  close(welch.p, t.p, 1e-12);
});

test('Mann–Whitney U: exact and normal approximation match R', () => {
  // wilcox.test(extra ~ group, data = sleep): W = 25.5, p-value = 0.06933 (ties → normal).
  const mw = mannWhitneyU(drug1, drug2);
  assert.equal(mw.statistic, 25.5);
  assert.equal(mw.exact, false);
  close(mw.p, 0.06933, 5e-6);
  // Complete separation of 3 vs 4 values: W = 0, exact p = 2 / C(7, 3) = 2/35.
  const sep = mannWhitneyU([1.1, 2.2, 3.3], [4.4, 5.5, 6.6, 7.7]);
  assert.equal(sep.statistic, 0);
  assert.equal(sep.exact, true);
  close(sep.p, 2 / 35, 1e-15);
  // R ?wilcox.test example: W = 35, p-value = 0.1272 (alternative = "greater", exact).
  const x = [0.80, 0.83, 1.89, 1.04, 1.45, 1.38, 1.91, 1.64, 0.73, 1.46];
  const y = [1.15, 0.88, 0.90, 0.74, 1.21];
  const greater = mannWhitneyU(x, y, { alternative: 'greater' });
  assert.equal(greater.statistic, 35);
  close(greater.p, 0.1272, 5e-5);
});

test('Wilcoxon signed-rank: exact and normal approximation match R', () => {
  // wilcox.test(extra[1:10], extra[11:20], paired = TRUE): V = 0, p-value = 0.009091.
  const sleep = wilcoxonSignedRank(drug1, drug2);
  assert.equal(sleep.statistic, 0);
  assert.equal(sleep.zeros, 1);
  close(sleep.p, 0.009091, 5e-7);
  // R ?wilcox.test (Hollander & Wolfe depression scores), paired, "greater": V = 40,
  // p = 10/512 = 0.01953125 (subsets of 1…9 with rank sum ≥ 40).
  const x = [1.83, 0.50, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.30];
  const y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];
  const result = wilcoxonSignedRank(x, y, { alternative: 'greater' });
  assert.equal(result.statistic, 40);
  close(result.p, 10 / 512, 1e-15);
  close(wilcoxonSignedRank([1, 2, 3, 4, 5]).p, 2 / 32, 1e-15);
});

test('Kruskal–Wallis matches the hand-computed statistic', () => {
  // Ranks 1…9 in three groups: H = 12/(9·10)·(6² + 15² + 24²)/3 − 30 = 7.2; p = e^{−3.6}.
  const kw = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  close(kw.statistic, 7.2, 1e-12);
  close(kw.p, Math.exp(-3.6), 1e-15);
  assert.equal(kw.df, 2);
  // Ties: the tie-corrected H is larger than the uncorrected one.
  const tied = kruskalWallis([[1, 1, 2], [2, 3, 3], [4, 4, 5]]);
  assert.ok(tied.statistic > 0 && tied.p < 0.1);
});

test("Fisher's exact and chi-square tests", () => {
  // Lady tasting tea, matrix(c(3, 1, 1, 3), 2): p = 34/70 two-sided, 17/70 "greater".
  close(fisherExact([[3, 1], [1, 3]]).p, 34 / 70, 1e-13);
  close(fisherExact([[3, 1], [1, 3]], { alternative: 'greater' }).p, 17 / 70, 1e-13);
  close(fisherExact([[3, 1], [1, 3]], { alternative: 'less' }).p, 69 / 70, 1e-13);
  // Yates-corrected 2×2: χ² = N(|ad − bc| − N/2)² / (r₁ r₂ c₁ c₂).
  const table = [[12, 5], [7, 9]];
  const yates = (33 * (Math.abs(12 * 9 - 5 * 7) - 16.5) ** 2) / (17 * 16 * 19 * 14);
  const chi = chiSquareTest(table);
  close(chi.statistic, yates, 1e-12);
  close(chi.p, erfc(Math.sqrt(yates / 2)), 1e-14);
  const plain = chiSquareTest(table, { correct: false });
  close(plain.statistic, (33 * (12 * 9 - 5 * 7) ** 2) / (17 * 16 * 19 * 14), 1e-12);
});

test('correlations', () => {
  // Spearman with a tie in y: ranks (1…5) vs (1, 2, 3.5, 5, 3.5): ρ = 8/√95.
  const s = spearmanCorrelation([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]);
  close(s.estimate, 8 / Math.sqrt(95), 1e-14);
  // Pearson with n = 4 (df = 2) has a closed-form p-value.
  const x = [1, 2, 3, 4];
  const y = [1.5, 1.9, 3.6, 3.7];
  const r = pearsonCorrelation(x, y);
  const t = (r.estimate * Math.sqrt(2)) / Math.sqrt(1 - r.estimate ** 2);
  close(r.p, 2 * (1 - tCdfExact[2](Math.abs(t))), 1e-14);
  // r from the definition: Sxy = 4.15, Sxx = 5, Syy = 3.8875.
  close(r.estimate, 4.15 / Math.sqrt(5 * 3.8875), 1e-14);
  const { ranks, ties } = rank([3, 1, 3, 2]);
  assert.deepEqual(Array.from(ranks), [3.5, 1, 3.5, 2]);
  assert.deepEqual(ties, [2]);
});

test('p-value adjustment matches R p.adjust', () => {
  const p = [0.01, 0.04, 0.03, 0.005];
  const bh = adjustPValues(p, 'BH');
  [0.02, 0.04, 0.04, 0.02].forEach((v, i) => close(bh[i], v, 1e-15, `BH ${i}`));
  const holm = adjustPValues(p, 'holm');
  [0.03, 0.06, 0.06, 0.02].forEach((v, i) => close(holm[i], v, 1e-15, `Holm ${i}`));
  const bonf = adjustPValues(p, 'bonferroni');
  [0.04, 0.16, 0.12, 0.02].forEach((v, i) => close(bonf[i], v, 1e-15, `Bonferroni ${i}`));
  const by = adjustPValues(p, 'BY');
  const q = 1 + 1 / 2 + 1 / 3 + 1 / 4;
  [0.02, 0.04, 0.04, 0.02].forEach((v, i) => close(by[i], v * q, 1e-15, `BY ${i}`));
  const withNaN = adjustPValues([0.01, Number.NaN, 0.04], 'bonferroni');
  close(withNaN[0], 0.02, 1e-15);
  assert.ok(Number.isNaN(withNaN[1]));
  assert.equal(adjustPValues([0.9, 0.8], 'bonferroni')[0], 1);
});

test('linear regression matches hand-computed OLS', () => {
  const X = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5]];
  const fit = linearRegression(X, [2, 4, 5, 4, 5]);
  close(fit.estimates[0], 2.2, 1e-14);
  close(fit.estimates[1], 0.6, 1e-14);
  close(fit.coefficients[1].se, Math.sqrt(0.08), 1e-14);
  close(fit.coefficients[0].se, Math.sqrt(0.88), 1e-14);
  close(fit.rSquared, 0.6, 1e-14); // SSR 3.6 / SST 6
  close(fit.fStatistic, 4.5, 1e-12);
  // Slope t = 0.6/√0.08 on 3 df; closed-form t₃ CDF.
  const t = 0.6 / Math.sqrt(0.08);
  close(fit.coefficients[1].p, 2 * (1 - tCdfExact[3](t)), 1e-14);
  close(fit.fP, fit.coefficients[1].p, 1e-13);
  assert.throws(() => linearRegression([[1, 2], [1, 2], [1, 2], [1, 2]], [1, 2, 3, 4]), /collinear/);
});

test('design matrices use treatment contrasts', () => {
  const d = designMatrix([
    { name: 'condition', values: ['ctrl', 'stim', 'ctrl', 'stim'] },
    { name: 'age', values: [30, 40, 50, 60] },
  ]);
  assert.deepEqual(d.names, ['(Intercept)', 'condition[stim]', 'age']);
  assert.deepEqual(d.matrix[1], [1, 1, 40]);
  const ref = designMatrix({ batch: ['a', 'b', 'c', 'a'] }, { intercept: true });
  assert.deepEqual(ref.names, ['(Intercept)', 'batch[b]', 'batch[c]']);
  const custom = designMatrix([{ name: 'g', values: ['x', 'y', 'x'], reference: 'y' }]);
  assert.deepEqual(custom.names, ['(Intercept)', 'g[x]']);
});

test('binomial and quasi-binomial GLM match closed-form two-group estimates', () => {
  // Two groups of two samples: the MLE equals the pooled group proportions.
  const s = [10, 20, 30, 40];
  const n = [100, 100, 100, 100];
  const X = [[1, 0], [1, 0], [1, 1], [1, 1]];
  const lg = (p) => Math.log(p / (1 - p));
  const fit = binomialGLM(s, n, X);
  assert.ok(fit.converged);
  close(fit.estimates[0], lg(0.15), 1e-9);
  close(fit.estimates[1], lg(0.35) - lg(0.15), 1e-9);
  const seBinomial = Math.sqrt(1 / 30 + 1 / 170 + 1 / 70 + 1 / 130);
  close(fit.standardErrors[1], seBinomial, 1e-8);
  // Pearson χ² = 2·25/12.75 + 2·25/22.75; φ = χ²/2.
  const pearson = 50 / 12.75 + 50 / 22.75;
  close(fit.pearsonChiSquare, pearson, 1e-8);
  const quasi = binomialGLM(s, n, X, { family: 'quasibinomial' });
  close(quasi.dispersion, pearson / 2, 1e-8);
  close(quasi.standardErrors[1], seBinomial * Math.sqrt(pearson / 2), 1e-8);
  // Likelihood-ratio F test through differentialAbundance: closed-form deviances.
  const dev = (mu) => 2 * s.reduce((acc, y, i) => acc + y * Math.log(y / (n[i] * mu[i])) + (n[i] - y) * Math.log((n[i] - y) / (n[i] * (1 - mu[i]))), 0);
  const dFull = dev([0.15, 0.15, 0.35, 0.35]);
  const dNull = dev([0.25, 0.25, 0.25, 0.25]);
  close(fit.deviance, dFull, 1e-8);
  const counts = s.map((v, i) => [v, n[i] - v]);
  const da = differentialAbundance(counts, n, { matrix: X, names: ['(Intercept)', 'stim'] }, { coefficient: 'stim' });
  const F = (dNull - dFull) / (pearson / 2);
  close(da.results[0].statistic, F, 1e-7);
  // F on (1, 2) df is t² on 2 df: P = 1 − √(F/(F + 2)).
  close(da.results[0].p, 1 - Math.sqrt(F / (F + 2)), 1e-8);
  assert.equal(da.coefficient, 'stim');
  close(da.results[0].log2OddsRatio, (lg(0.35) - lg(0.15)) / Math.LN2, 1e-8);
});

test('differential abundance finds a changed cluster among null ones', () => {
  const random = createRandom(11);
  const samples = 8;
  const clusters = 6;
  const condition = ['ctrl', 'ctrl', 'ctrl', 'ctrl', 'stim', 'stim', 'stim', 'stim'];
  const base = [0.3, 0.2, 0.15, 0.15, 0.1, 0.1];
  const counts = [];
  for (let s = 0; s < samples; s += 1) {
    const props = base.map((b, c) => (c === 4 && condition[s] === 'stim' ? b * 3 : b) * Math.exp(0.15 * random.gaussian()));
    const sum = props.reduce((a, b) => a + b, 0);
    counts.push(props.map((p) => Math.round((20000 * p) / sum)));
  }
  const design = designMatrix({ condition });
  const result = differentialAbundance(counts, null, design, { coefficient: 'condition[stim]' });
  const changed = result.results[4];
  assert.ok(changed.padj < 1e-3, `changed cluster padj ${changed.padj}`);
  assert.ok(changed.log2OddsRatio > 1.2, `log2 OR ${changed.log2OddsRatio}`);
  const nullHits = result.results.filter((r, c) => c !== 4 && c !== 0 && r.padj < 0.01);
  assert.ok(nullHits.length <= 1, 'compositional null clusters mostly not significant');
  const wald = differentialAbundance(counts, null, design, { coefficient: 'condition[stim]', test: 'wald' });
  assert.ok(wald.results[4].p < 1e-3);
});

test('effect sizes: Cohen d, Hedges g, Hodges–Lehmann, fold change, bootstrap', () => {
  const effect = cohensD(drug2, drug1);
  // Pooled SD from the sleep data: SDs 2.002249 and 1.789010 → d = 1.58 / √((s1² + s2²)/2).
  const sd = (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  };
  const s1 = sd(drug1);
  const s2 = sd(drug2);
  close(s1, 1.789010, 5e-7, 'sd(drug 1) as R');
  close(s2, 2.002249, 5e-7, 'sd(drug 2) as R');
  const d = 1.58 / Math.sqrt((s1 * s1 + s2 * s2) / 2);
  close(effect.d, d, 1e-12);
  // J(18) = Γ(9) / (3 Γ(8.5)), Γ(8.5) = (15!!/2⁸)√π.
  const J = 40320 / (3 * (2027025 / 256) * Math.sqrt(Math.PI));
  close(effect.g, d * J, 1e-12);
  assert.ok(effect.ciD[0] < d && effect.ciD[1] > d);
  // Hodges–Lehmann of (1,2,3) vs (0, 0.5): differences 1, .5, 2, 1.5, 3, 2.5 → median 1.75.
  close(hodgesLehmann([1, 2, 3], [0, 0.5]).estimate, 1.75, 1e-15);
  // With m = 10, n = 5 and 95%: qwilcox(0.025, 10, 5) = 9 → CI = [D(9), D(42)].
  const x = [0.80, 0.83, 1.89, 1.04, 1.45, 1.38, 1.91, 1.64, 0.73, 1.46];
  const y = [1.15, 0.88, 0.90, 0.74, 1.21];
  const diffs = [];
  for (const a of x) for (const b of y) diffs.push(a - b);
  diffs.sort((a, b) => a - b);
  const hl = hodgesLehmann(x, y);
  close(hl.ci[0], diffs[8], 1e-15);
  close(hl.ci[1], diffs[41], 1e-15);
  const fc = foldChange([4, 4.4, 3.6], [2, 2.2, 1.8]);
  close(fc.foldChange, 2, 1e-12);
  close(fc.log2FoldChange, 1, 1e-12);
  assert.ok(fc.ci[0] < 2 && fc.ci[1] > 2);
  const geo = foldChange([4, 8, 16], [1, 2, 4], { statistic: 'geomean' });
  close(geo.log2FoldChange, 2, 1e-12);
  close(geo.ciLog2[0] + geo.ciLog2[1], 4, 1e-12, 'symmetric on the log scale');
  const b1 = bootstrap([drug1, drug2], (a, b) => b.reduce((s, v) => s + v, 0) / b.length - a.reduce((s, v) => s + v, 0) / a.length, { seed: 5, iterations: 1000 });
  const b2 = bootstrap([drug1, drug2], (a, b) => b.reduce((s, v) => s + v, 0) / b.length - a.reduce((s, v) => s + v, 0) / a.length, { seed: 5, iterations: 1000 });
  assert.deepEqual(b1.ci, b2.ci);
  close(b1.estimate, 1.58, 1e-12);
  assert.ok(b1.ci[0] < 1.58 && b1.ci[1] > 1.58 && b1.ci[0] > -1);
  const boot = cohensD(drug2, drug1, { bootstrap: true, seed: 3, iterations: 500 });
  assert.equal(boot.ciMethod, 'percentile bootstrap');
});

test('frequency transforms', () => {
  close(logit(0.5), 0, 1e-15);
  close(logit(0, 1e-6), Math.log(1e-6 / (1 - 1e-6)), 1e-12);
  close(arcsineSqrt(0.5), Math.PI / 4, 1e-15);
});

test('Friedman test matches R and block ANOVA matches the two-way OLS F test', () => {
  // ?friedman.test (Hollander & Wolfe, rounding first base): chi-squared = 11.143, df = 2,
  // p-value = 0.003805 (with tie correction).
  const rounding = [
    [5.40, 5.50, 5.55], [5.85, 5.70, 5.75], [5.20, 5.60, 5.50], [5.55, 5.50, 5.40], [5.90, 5.85, 5.70],
    [5.45, 5.55, 5.60], [5.40, 5.40, 5.35], [5.45, 5.50, 5.35], [5.25, 5.15, 5.00], [5.85, 5.80, 5.70],
    [5.25, 5.20, 5.10], [5.65, 5.55, 5.45], [5.60, 5.35, 5.45], [5.05, 5.00, 4.95], [5.50, 5.50, 5.40],
    [5.45, 5.55, 5.50], [5.55, 5.55, 5.35], [5.45, 5.50, 5.55], [5.50, 5.45, 5.25], [5.65, 5.60, 5.40],
    [5.70, 5.65, 5.55], [6.30, 6.30, 6.25],
  ];
  const fr = friedmanTest(rounding);
  close(fr.statistic, 11.143, 5e-4);
  close(fr.p, 0.003805, 5e-7);
  // Perfectly consistent ranks in 3 blocks: Q = 12·18/(3·3·4) = 6, p = e^{−3}.
  close(friedmanTest([[1, 2, 3], [1, 2, 3], [1, 2, 3]]).statistic, 6, 1e-12);
  // Block ANOVA F equals the nested-model F of OLS with subject and condition indicators.
  const data = [[1, 2, 6], [2, 4, 6.5], [3, 6, 9], [2.5, 3, 7]];
  const result = blockAnova(data);
  const rows = [];
  const y = [];
  data.forEach((row, i) => row.forEach((v, j) => {
    rows.push([1, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0]);
    y.push(v);
  }));
  const full = linearRegression(rows, y);
  const reduced = linearRegression(rows.map((r) => r.slice(0, 4)), y);
  const rss = (fit) => fit.residuals.reduce((a, b) => a + b * b, 0);
  const F = ((rss(reduced) - rss(full)) / 2) / (rss(full) / 6);
  close(result.statistic, F, 1e-9);
  assert.equal(result.df2, 6);
  close(result.p, fSurvival(F, 2, 6), 1e-12);
});
