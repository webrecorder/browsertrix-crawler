
class constants {
  constructor(){
    this.HTML_TYPES = ["text/html", "application/xhtml", "application/xhtml+xml"];
    this.WAIT_UNTIL_OPTS = ["load", "domcontentloaded", "networkidle0", "networkidle2"];
    this.BEHAVIOR_LOG_FUNC = "__bx_log";
    this.CHROME_PATH = "google-chrome";
  }
}

module.exports.constants = constants;
