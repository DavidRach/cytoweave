# The R client against a running CytoWeave: its results equal the HTTP API's for the same actions,
# it finds CytoWeave through the connection file, and exports, images and errors work.
# clients/test-clients.mjs starts CytoWeave (the PBMC example with its suggested gates) and sets
# CYTOWEAVE_TEST_URL, CYTOWEAVE_TEST_TOKEN, CYTOWEAVE_TEST_DIR and CYTOWEAVE_DATA_DIR; without them
# the tests that need CytoWeave are skipped.

url <- Sys.getenv("CYTOWEAVE_TEST_URL")
token <- Sys.getenv("CYTOWEAVE_TEST_TOKEN")
out <- Sys.getenv("CYTOWEAVE_TEST_DIR", tempdir())
live <- function() skip_if(!nzchar(url), "needs a running CytoWeave (node clients/test-clients.mjs)")

# The same action sent to the HTTP API directly, parsed as the client parses answers.
http <- function(action, args = structure(list(), names = character(0))) {
  handle <- curl::new_handle()
  curl::handle_setheaders(handle, "Content-Type" = "application/json", "X-CytoWeave-Token" = token)
  curl::handle_setopt(handle, customrequest = "POST", postfields = jsonlite::toJSON(list(action = action, args = args, client = "R"), auto_unbox = TRUE))
  response <- curl::curl_fetch_memory(paste0(url, "/api/remote/action"), handle = handle)
  text <- rawToChar(response$content)
  Encoding(text) <- "UTF-8"
  jsonlite::fromJSON(text)
}

test_that("it connects through the connection file, and its version is the program's", {
  live()
  cw <- cw_connect(client = "R")
  expect_equal(cw$url, url)
  expect_equal(cw$token, token)
  expect_equal(cw$version, as.character(utils::packageVersion("cytoweave")))
})

test_that("every action is a function", {
  live()
  tools <- cw_tools()
  expect_gt(nrow(tools), 30)
  missing <- tools$name[!vapply(paste0("cw_", tools$name), exists, logical(1), envir = asNamespace("cytoweave"))]
  expect_equal(missing, character(0))
})

test_that("results equal the HTTP API's", {
  live()
  cases <- list(
    list(function() cw_workspace_summary(), "workspace_summary", structure(list(), names = character(0))),
    list(function() cw_list_populations(sample = "D01_Stim"), "list_populations", list(sample = "D01_Stim")),
    list(function() cw_statistics_table(statistic = "freqParent", populations = c("T cells", "Monocytes")), "statistics_table", list(statistic = "freqParent", populations = list("T cells", "Monocytes"))),
    list(function() cw_compare("T cells", "condition", pair_by = "subject"), "compare", list(population = "T cells", groupBy = "condition", pairBy = "subject")),
    list(function() cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"), pair_by = "subject", populations = c("T cells", "Monocytes"), min_cells = 5), "differential_analysis", list(groupBy = "condition", groups = list("Unstimulated", "Stimulated"), pairBy = "subject", populations = list("T cells", "Monocytes"), minCells = 5)),
    # A list of one element stays a list (an array), not a string.
    list(function() cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"), populations = "T cells"), "differential_analysis", list(groupBy = "condition", groups = list("Unstimulated", "Stimulated"), populations = list("T cells")))
  )
  for (case in cases) {
    mine <- case[[1]]()
    theirs <- http(case[[2]], case[[3]])
    expect_true(theirs$ok, info = case[[2]])
    expect_equal(mine$message, theirs$message, info = case[[2]])
    expect_equal(mine$data, theirs$data, info = case[[2]])
  }
})

test_that("tables come back as data frames", {
  live()
  result <- cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"), pair_by = "subject", populations = "T cells", limit = 500)
  rows <- as.data.frame(result)
  expect_s3_class(rows, "data.frame")
  expect_true(all(c("marker", "logFC", "p", "padj") %in% names(rows)))
  cd25 <- rows[rows$marker == "CD25", ]
  expect_gt(cd25$logFC, 0)
  expect_lt(cd25$padj, 0.05)
  expect_output(print(result), "Differential state")
})

test_that("exports need the token and never replace a file", {
  live()
  path <- file.path(out, "r-table.csv")
  unlink(path)
  cw_export_table(path, statistic = "freqParent")
  expect_true(file.exists(path))
  expect_error(cw_export_table(path, statistic = "freqParent"), "exists", class = "cytoweave_error")
  cw_export_table(path, statistic = "freqParent", overwrite = TRUE)
  without <- structure(list(url = url, token = "", client = "R", timeout = 60), class = "cytoweave")
  refused <- tryCatch(cw_export_table(file.path(out, "r-other.csv"), cw = without), cytoweave_error = function(e) e)
  expect_equal(refused$status, 401)
})

test_that("a plot is saved as PNG", {
  live()
  path <- file.path(out, "r-plot.png")
  cw_render_plot("CD3", population = "T cells", sample = "D01_Stim", file = path)
  expect_equal(readBin(path, "raw", 8), as.raw(c(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
})

test_that("errors carry the reason", {
  live()
  expect_error(cw_call("no_such_action"), "Unknown action", class = "cytoweave_error")
  expect_error(cw_differential_analysis("no_such_field"), "no_such_field", class = "cytoweave_error")
  gone <- tryCatch(cw_connect("http://127.0.0.1:9", ""), cytoweave_error = function(e) e)
  expect_equal(gone$status, 0)
})

test_that("the connection file and the environment, without CytoWeave", {
  folder <- tempfile()
  dir.create(folder)
  saved <- Sys.getenv(c("CYTOWEAVE_URL", "CYTOWEAVE_TOKEN"), unset = NA)
  Sys.unsetenv(c("CYTOWEAVE_URL", "CYTOWEAVE_TOKEN"))
  on.exit(for (k in names(saved)) if (!is.na(saved[[k]])) do.call(Sys.setenv, stats::setNames(list(saved[[k]]), k)), add = TRUE)
  expect_equal(cytoweave:::.cw_find(folder)$url, "http://127.0.0.1:8770")
  writeLines('{"url": "http://127.0.0.1:8799", "token": "abc", "version": "x", "pid": 1}', file.path(folder, "remote.json"))
  found <- cytoweave:::.cw_find(folder)
  expect_equal(found$url, "http://127.0.0.1:8799")
  expect_equal(found$token, "abc")
})
