# Writes validation/reference/curves.json: drc 4.0's fits of the synthetic curves, the drug-screen
# example's dose-responses and the bead-immunoassay example's standard curves (with beadplexr's
# fit_standard_curve and calculate_concentration), and beadplexr's own LEGENDplex analysis of its
# package data (lplex: a Human Growth Factor panel, standards C0-C7 and a sample in duplicate) as
# its vignette runs it. The lplex events, with beadplexr's bead groups and analytes, go to
# validation/cache/curves/lplex/ for validation/run.mjs (suite curves) to identify the beads itself.
# R is needed only to regenerate these.
#
#   node validation/reference/write_curves.mjs
#   Rscript -e 'install.packages(c("drc", "beadplexr"))'
#   Rscript validation/reference/generate_curves.R
#
# Every fit is started from drc's own starting values and from a few others (the five-parameter
# curve mirrored, other asymmetries), keeping the lowest residual sum of squares, and also from
# CytoWeave's estimate, so that the same optimum can be compared. drc's standard errors come from
# optim's numerical Hessian (coarse steps); as an exact reference, the Hessian of the residual sum
# of squares at that optimum is also taken with numDeriv (Richardson extrapolation), and from it the
# parameters', the EC50's and the concentrations' standard errors by the delta method. (drc's
# ED(type = "absolute") reports standard errors that the delta method with drc's own covariance
# does not reproduce, so concentrations' errors are compared with the exact ones.)

suppressPackageStartupMessages({
  library(drc)
  library(numDeriv)
  library(beadplexr)
  library(dplyr)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
folder <- file.path(here, "..", "cache", "curves")
num <- function(v) if (is.null(v)) NA_real_ else as.numeric(v)
s12 <- function(v) signif(as.numeric(v), 12)

sigma_for <- function(y, weighting) {
  if (is.null(weighting) || weighting == "none") return(NULL)
  floor <- min(y[y > 0]) / 10
  a <- pmax(abs(y), floor)
  if (weighting == "1/y") sqrt(a) else a
}

fct_for <- function(model, fixed) {
  f <- c(NA, NA, NA, NA, NA)
  if (!is.null(fixed)) for (name in names(fixed)) f[match(name, c("b", "c", "d", "e", "f"))] <- fixed[[name]]
  if (model == "LL.4") LL.4(fixed = f[1:4]) else LL.5(fixed = f)
}

fit_best <- function(x, y, model, weighting = "none", fixed = NULL, ours = NULL) {
  w <- sigma_for(y, weighting)
  # drm finds its weights in the data frame (it evaluates them as model.frame does).
  d <- data.frame(x = x, y = y, w = if (is.null(w)) 1 else w)
  fct <- fct_for(model, fixed)
  free <- is.na(fct$fixed)
  try_fit <- function(start = NULL) {
    call <- function() {
      if (is.null(start) && is.null(w)) return(drm(y ~ x, data = d, fct = fct))
      if (is.null(start)) return(drm(y ~ x, data = d, fct = fct, weights = w))
      if (is.null(w)) return(drm(y ~ x, data = d, fct = fct, start = start))
      drm(y ~ x, data = d, fct = fct, weights = w, start = start)
    }
    fit <- tryCatch(suppressWarnings(call()), error = function(e) NULL)
    if (is.null(fit)) return(NULL)
    if (!is.finite(sum(residuals(fit)^2))) return(NULL)
    fit
  }
  fits <- list(try_fit())
  base <- fits[[1]]
  if (!is.null(base)) {
    cf <- coef(base)
    full <- c(b = NA, c = NA, d = NA, e = NA, f = 1)
    names_free <- sub(":\\(Intercept\\)", "", names(cf))
    full[names_free] <- cf
    pick <- function(v) unname(v[seq_along(free)][free])
    if (model == "LL.5") {
      for (fs in c(0.3, 1, 3)) {
        fits[[length(fits) + 1]] <- try_fit(pick(c(full["b"], full["c"], full["d"], full["e"], f = fs)))
        fits[[length(fits) + 1]] <- try_fit(pick(c(-full["b"], full["d"], full["c"], full["e"], f = fs)))
      }
    }
  }
  fits <- Filter(Negate(is.null), fits)
  rss_of <- function(fit) if (is.null(w)) sum(residuals(fit)^2) else sum((residuals(fit) / w)^2)
  # From CytoWeave's estimate: the same optimum, with drc's standard errors.
  from_ours <- NULL
  if (!is.null(ours)) {
    full <- c(b = num(ours$b), c = num(ours$c), d = num(ours$d), e = num(ours$e), f = num(ours$f))
    from_ours <- try_fit(unname(full[seq_along(free)][free]))
  }
  if (!length(fits) && is.null(from_ours)) return(NULL)
  rss <- vapply(fits, rss_of, 0)
  list(fit = if (length(fits)) fits[[which.min(rss)]] else NULL, ours = from_ours, rss = if (length(rss)) min(rss) else NA, defaultRss = if (length(rss)) rss[1] else NA,
       oursRss = if (is.null(from_ours)) NA else rss_of(from_ours), w = w, d = d, model = model, fixed = fct$fixed,
       exact = if (is.null(from_ours)) NULL else exact_covariance(from_ours, d, w, model, fct$fixed))
}

# The exact covariance of the free parameters at a fit: s² (H/2)⁻¹, H the numDeriv Hessian of the
# weighted residual sum of squares. Returns { p (free, named), full (b, c, d, e, f builder), V }.
exact_covariance <- function(fit, d, w, model, fixed) {
  fixed5 <- if (model == "LL.4") c(fixed, 1) else fixed
  free <- is.na(fixed5)
  p <- coef(fit)
  full <- function(q) { v <- fixed5; v[free] <- q; v }
  sigma <- if (is.null(w)) rep(1, nrow(d)) else w
  f5 <- function(v, x) v[2] + (v[3] - v[2]) / (1 + exp(v[1] * (log(x) - log(v[4]))))^v[5]
  rss <- function(q) sum(((d$y - f5(full(q), d$x)) / sigma)^2)
  H <- hessian(rss, unname(p))
  s2 <- rss(unname(p)) / df.residual(fit)
  V <- tryCatch(s2 * solve(H / 2), error = function(e) NULL)
  list(p = unname(p), full = full, V = V)
}

exact_delta <- function(exact, g) {
  if (is.null(exact$V)) return(NA_real_)
  gr <- grad(function(q) g(exact$full(q)), exact$p)
  sqrt(max(0, as.numeric(t(gr) %*% exact$V %*% gr)))
}

ec50_of <- function(v) v[4] * (2^(1 / v[5]) - 1)^(1 / v[1])
dose_at <- function(y0) function(v) { g <- (y0 - v[2]) / (v[3] - v[2]); v[4] * (g^(-1 / v[5]) - 1)^(1 / v[1]) }

one_fit <- function(fit) {
  if (is.null(fit)) return(NULL)
  co <- summary(fit)$coefficients
  names <- sub(":\\(Intercept\\)", "", rownames(co))
  ed <- tryCatch(suppressWarnings(ED(fit, 50, interval = "delta", display = FALSE)), error = function(e) matrix(NA, 1, 4))
  list(
    coefficients = as.list(setNames(s12(co[, 1]), names)),
    standardErrors = as.list(setNames(s12(co[, 2]), names)),
    df = df.residual(fit),
    ec50 = s12(ed[1, 1]),
    ec50SE = s12(ed[1, 2])
  )
}

# drc's best fit from its own starts (rss, defaultRss: of its default start alone) and its fit
# from CytoWeave's estimate (ours, oursRss).
describe <- function(best) {
  if (is.null(best)) return(NULL)
  exact <- best$exact
  exactSE <- if (is.null(exact$V)) NULL else as.list(setNames(s12(sqrt(pmax(0, diag(exact$V)))), sub(":\\(Intercept\\)", "", names(coef(best$ours)))))
  c(one_fit(best$fit), list(rss = s12(best$rss), defaultRss = s12(best$defaultRss), oursRss = s12(best$oursRss),
    ours = c(one_fit(best$ours), list(exactSE = exactSE, exactEC50SE = if (is.null(exact)) NA else s12(exact_delta(exact, ec50_of))))))
}

# --- Synthetic curves and the screen ---------------------------------------------------------------

cases <- fromJSON(file.path(folder, "cases.json"), simplifyVector = FALSE)
case_fits <- lapply(cases, function(k) {
  x <- vapply(k$x, num, 0)
  y <- vapply(k$y, num, 0)
  c(list(name = k$name), describe(fit_best(x, y, k$model, k$weighting, k$fixed, k$start)))
})

screen <- fromJSON(file.path(folder, "screen.json"), simplifyVector = FALSE)
screen_fits <- lapply(screen$compounds, function(k) {
  c(list(name = k$name), describe(fit_best(vapply(k$x, num, 0), vapply(k$y, num, 0), "LL.4", "none", NULL, k$start)))
})
normalized <- c(list(name = screen$normalized$name), describe(fit_best(vapply(screen$normalized$x, num, 0), vapply(screen$normalized$y, num, 0), "LL.4", "none", list(c = 0, d = 100), screen$normalized$start)))

# --- The bead assay: beadplexr's standard curve and concentrations, and a weighted drc fit ---------

beads <- fromJSON(file.path(folder, "beads.json"), simplifyVector = FALSE)
bead_fits <- lapply(names(beads), function(statistic) {
  lapply(beads[[statistic]], function(a) {
    std <- data.frame(FL2.H = vapply(a$standards, function(s) num(s$mfi), 0), Concentration = vapply(a$standards, function(s) num(s$concentration), 0))
    samples <- data.frame(FL2.H = vapply(a$samples, function(s) num(s$mfi), 0))
    plain <- fit_standard_curve(std)
    est <- calculate_concentration(samples, plain)
    best <- fit_best(std$Concentration, std$FL2.H, "LL.5", "none", NULL, a$start)
    weighted <- fit_best(std$Concentration, std$FL2.H, "LL.5", "1/y2", NULL, a$startWeighted)
    # Concentrations of the sera on the curves started from CytoWeave's estimates (drc's ED, as
    # beadplexr's calculate_concentration takes them).
    est_ours <- if (is.null(best$ours)) NULL else calculate_concentration(samples, best$ours)
    weighted_est <- if (is.null(weighted$ours)) NULL else suppressWarnings(ED(weighted$ours, samples$FL2.H, type = "absolute", display = FALSE))
    exact_errors <- function(b) if (is.null(b$exact)) NULL else s12(vapply(samples$FL2.H, function(y0) exact_delta(b$exact, dose_at(y0)), 0))
    list(
      name = a$name,
      beadplexr = list(coefficients = as.list(setNames(s12(coef(plain)), c("b", "c", "d", "e", "f"))), rss = s12(sum(residuals(plain)^2)), concentration = s12(est$Calc.conc), error = s12(est$`Calc.conc error`)),
      best = c(describe(best), list(concentration = s12(est_ours$Calc.conc), error = s12(est_ours$`Calc.conc error`), exactError = exact_errors(best))),
      weighted = c(describe(weighted), list(concentration = s12(weighted_est[, 1]), error = s12(weighted_est[, 2]), exactError = exact_errors(weighted)))
    )
  })
})
names(bead_fits) <- names(beads)

# --- beadplexr on its own LEGENDplex data, as its vignette runs it ---------------------------------

data(lplex)
panel_info <- load_panel(.panel_name = "Human Growth Factor Panel (13-plex)")
args_ident <- list(fs = list(.parameter = c("FSC-A", "SSC-A"), .column_name = "Bead group", .method = "mclust", .trim = 0.03),
                   analytes = list(.parameter = "FL6-H", .column_name = "Analyte ID"))
find_and_trim <- function(df) {
  identify_legendplex_analyte(df, .analytes = panel_info$analytes, .method_args = args_ident) |>
    mutate(tmp_aid = `Analyte ID`) |>
    nest_by(tmp_aid) |>
    mutate(data = list(trim_population(data, .parameter = c("FL6-H", "FL2-H"), .column_name = "Analyte ID", .trim = 0.1))) |>
    reframe(data)
}
lplex_folder <- file.path(folder, "lplex")
dir.create(lplex_folder, recursive = TRUE, showWarnings = FALSE)
set.seed(1)
identified <- lapply(names(lplex), function(file) {
  df <- lplex[[file]]
  df$event <- seq_len(nrow(df))
  out <- find_and_trim(df) |> arrange(event)
  events <- df |> left_join(out |> dplyr::select(event, `Bead group`, `Analyte ID`), by = "event")
  write.csv(events, file.path(lplex_folder, sub("\\.fcs$", ".csv", file)), row.names = FALSE, na = "")
  out
})
names(identified) <- names(lplex)
analyte_mfi <- bind_rows(lapply(names(identified), function(file) {
  calc_analyte_mfi(identified[[file]], .parameter = "FL2-H", .column_name = "Analyte ID", .mean_fun = "geometric") |> mutate(Sample = file)
})) |> filter(!is.na(`Analyte ID`))
counts <- bind_rows(lapply(names(identified), function(file) {
  identified[[file]] |> filter(!is.na(`Analyte ID`)) |> count(`Analyte ID`) |> mutate(Sample = file)
}))
standard_data <- analyte_mfi |> filter(grepl("C[0-9]", Sample)) |>
  mutate(`Sample number` = as.numeric(substr(regmatches(Sample, regexpr("C[0-9]", Sample)), 2, 2))) |>
  left_join(as_data_frame_analyte(panel_info$analytes), by = "Analyte ID") |>
  group_by(`Analyte ID`) |>
  mutate(Concentration = calc_std_conc(`Sample number`, concentration, .dilution_factor = panel_info$std_dilution)) |>
  ungroup()
sample_data <- analyte_mfi |> filter(!grepl("C[0-9]", Sample))
lplex_curves <- lapply(sort(unique(standard_data$`Analyte ID`)), function(id) {
  std <- standard_data |> filter(`Analyte ID` == id)
  fit_input <- data.frame(FL2.H = log10(std$`FL2-H`), Concentration = log10(std$Concentration))
  fit <- fit_standard_curve(fit_input)
  smp <- sample_data |> filter(`Analyte ID` == id)
  est <- calculate_concentration(data.frame(FL2.H = log10(smp$`FL2-H`)), fit)
  list(
    analyte = id,
    name = std$name[1],
    standards = list(sample = std$Sample, concentration = s12(std$Concentration), mfi = s12(std$`FL2-H`)),
    coefficients = as.list(setNames(s12(coef(fit)), c("b", "c", "d", "e", "f"))),
    rss = s12(sum(residuals(fit)^2)),
    samples = list(sample = smp$Sample, mfi = s12(smp$`FL2-H`), log10Concentration = s12(est$Calc.conc), error = s12(est$`Calc.conc error`))
  )
})

out <- list(
  drc = as.character(packageVersion("drc")),
  beadplexr = as.character(packageVersion("beadplexr")),
  cases = case_fits,
  screen = list(compounds = screen_fits, normalized = normalized),
  beads = bead_fits,
  lplex = list(
    panel = panel_info$panel_name,
    analytes = lapply(names(panel_info$analytes), function(g) list(group = g, ids = names(panel_info$analytes[[g]]))),
    counts = lapply(split(counts, counts$Sample), function(d) as.list(setNames(d$n, d$`Analyte ID`))),
    mfi = lapply(split(analyte_mfi, analyte_mfi$Sample), function(d) as.list(setNames(s12(d$`FL2-H`), d$`Analyte ID`))),
    curves = lplex_curves
  )
)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, na = "null", null = "null", pretty = FALSE), file.path(here, "curves.json"))
cat("Wrote", file.path(here, "curves.json"), "\n")
