# Remote control of a running CytoWeave: the connection, any action by its name, and results.
# The help pages are in man/; NAMESPACE and the action functions (tools.R) are written by
# clients/generate.mjs.

.cw <- new.env(parent = emptyenv())

# Connect to a running CytoWeave
#
# CytoWeave started with --remote-control accepts actions from programs on this computer.
# Without arguments, the connection is found in the environment (CYTOWEAVE_URL,
# CYTOWEAVE_TOKEN) or in the remote.json file CytoWeave writes to its data folder
# (data_dir, CYTOWEAVE_DATA_DIR or the default folder).
cw_connect <- function(url = NULL, token = NULL, client = "R", timeout = 3600, data_dir = NULL) {
  if (is.null(url) || is.null(token)) {
    found <- .cw_find(data_dir)
    if (is.null(url)) url <- found$url
    if (is.null(token)) token <- found$token
  }
  cw <- structure(list(url = sub("/+$", "", url), token = token, client = client, timeout = timeout), class = "cytoweave")
  info <- .cw_request(cw, "GET", "/api/remote/tools")
  cw$version <- info$version
  .cw$default <- cw
  cw
}

# The connection the functions use by default: the last one cw_connect() made.
cw_default <- function() {
  if (is.null(.cw$default)) cw_connect() else .cw$default
}

# Perform any CytoWeave action by its name
#
# Arguments are named as CytoWeave names them (camelCase); NULL arguments are left out.
cw_call <- function(action, ..., .args = list(), cw = cw_default()) {
  args <- c(list(...), .args)
  args <- args[!vapply(args, is.null, logical(1))]
  if (!length(args)) args <- structure(list(), names = character(0))
  body <- jsonlite::toJSON(list(action = action, args = args, client = cw$client), auto_unbox = TRUE, null = "null", digits = NA)
  answer <- .cw_request(cw, "POST", "/api/remote/action", body, action)
  if (!isTRUE(answer$ok)) {
    stop(.cw_error(if (!is.null(answer$message)) answer$message else paste(action, "failed"), 200, action))
  }
  structure(list(action = action, message = answer$message, data = answer$data), class = "cytoweave_result")
}

# The actions this CytoWeave performs
cw_tools <- function(cw = cw_default()) {
  info <- .cw_request(cw, "GET", "/api/remote/tools", simplify = TRUE)
  info$tools[, c("name", "title", "description")]
}

# Save the image of a render_plot result as a PNG file
cw_save_image <- function(result, file) {
  image <- result$data$image
  prefix <- "data:image/png;base64,"
  if (is.null(image) || !startsWith(image, prefix)) stop(.cw_error(paste(result$action, "returned no PNG image"), 0, result$action))
  writeBin(jsonlite::base64_dec(substring(image, nchar(prefix) + 1)), file)
  invisible(file)
}

print.cytoweave <- function(x, ...) {
  cat("<CytoWeave ", x$version, " at ", x$url, if (is.null(x$token) || !nzchar(x$token)) " (no token)", ">\n", sep = "")
  invisible(x)
}

print.cytoweave_result <- function(x, ...) {
  cat(x$action, ": ", x$message, "\n", sep = "")
  invisible(x)
}

# A list of records in a result's data as a data frame: data[[key]], or the first one found
as.data.frame.cytoweave_result <- function(x, row.names = NULL, optional = FALSE, key = NULL, ...) {
  value <- if (!is.null(key)) x$data[[key]] else if (is.data.frame(x$data)) x$data else Find(is.data.frame, x$data)
  if (is.null(value)) stop(paste0(x$action, " returned no table; its data has ", paste(names(x$data), collapse = ", ")))
  as.data.frame(value, row.names = row.names, optional = optional, ...)
}

# --- Internals ------------------------------------------------------------------------------------

# Arrays stay arrays in JSON, even of one element.
.cw_array <- function(x) if (is.null(x)) NULL else as.list(x)

.cw_error <- function(message, status, action) {
  structure(class = c("cytoweave_error", "error", "condition"), list(message = message, call = NULL, status = status, action = action))
}

.cw_default_data_dir <- function() {
  home <- path.expand("~")
  if (.Platform$OS.type == "windows") {
    base <- Sys.getenv("APPDATA")
    return(if (nzchar(base)) file.path(base, "CytoWeave") else file.path(home, ".cytoweave"))
  }
  if (Sys.info()[["sysname"]] == "Darwin") return(file.path(home, "Library", "Application Support", "CytoWeave"))
  base <- Sys.getenv("XDG_CONFIG_HOME")
  file.path(if (nzchar(base)) base else file.path(home, ".config"), "CytoWeave")
}

.cw_find <- function(data_dir = NULL) {
  url <- Sys.getenv("CYTOWEAVE_URL")
  token <- Sys.getenv("CYTOWEAVE_TOKEN")
  token <- if (nzchar(token)) token else NULL
  if (nzchar(url)) return(list(url = url, token = token))
  folder <- if (!is.null(data_dir)) data_dir else if (nzchar(Sys.getenv("CYTOWEAVE_DATA_DIR"))) Sys.getenv("CYTOWEAVE_DATA_DIR") else .cw_default_data_dir()
  path <- file.path(folder, "remote.json")
  info <- tryCatch(jsonlite::fromJSON(path), error = function(e) NULL)
  if (is.null(info$url)) return(list(url = "http://127.0.0.1:8770", token = token))
  list(url = info$url, token = if (!is.null(token)) token else info$token)
}

.cw_request <- function(cw, method, path, body = NULL, action = NULL, simplify = TRUE) {
  handle <- curl::new_handle(timeout = cw$timeout)
  headers <- c(Accept = "application/json")
  if (!is.null(cw$token) && nzchar(cw$token)) headers[["X-CytoWeave-Token"]] <- cw$token
  if (!is.null(body)) {
    headers[["Content-Type"]] <- "application/json"
    curl::handle_setopt(handle, customrequest = method, postfields = enc2utf8(as.character(body)))
  }
  do.call(curl::handle_setheaders, c(list(handle), as.list(headers)))
  response <- tryCatch(curl::curl_fetch_memory(paste0(cw$url, path), handle = handle), error = function(e) {
    stop(.cw_error(paste0("CytoWeave is not running at ", cw$url, " (", conditionMessage(e), "). Start it with: cytoweave --remote-control"), 0, action))
  })
  text <- rawToChar(response$content)
  Encoding(text) <- "UTF-8"
  answer <- tryCatch(jsonlite::fromJSON(text, simplifyVector = simplify), error = function(e) NULL)
  if (response$status_code >= 400) {
    message <- if (!is.null(answer$error)) answer$error else text
    if (response$status_code == 404 && path == "/api/remote/action") message <- paste0(cw$url, " does not accept actions: start CytoWeave with --remote-control.")
    stop(.cw_error(message, response$status_code, action))
  }
  if (is.null(answer)) stop(.cw_error(paste("CytoWeave answered with something other than JSON:", substr(text, 1, 200)), response$status_code, action))
  answer
}
