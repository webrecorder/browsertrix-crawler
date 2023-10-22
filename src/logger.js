"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
exports.logger = exports.errJSON = void 0;
// ===========================================================================
// to fix serialization of regexes for logging purposes
// RegExp.prototype.toJSON = RegExp.prototype.toString;
Object.defineProperty(RegExp.prototype, "toJSON", { value: RegExp.prototype.toString });
// ===========================================================================
function errJSON(e) {
    return { "type": "exception", "message": e.message, "stack": e.stack };
}
exports.errJSON = errJSON;
// ===========================================================================
var Logger = /** @class */ (function () {
    function Logger() {
        this.logStream = null;
        this.debugLogging = false;
        this.logErrorsToRedis = false;
        this.logLevels = [];
        this.contexts = [];
        this.crawlState = null;
    }
    Logger.prototype.setExternalLogStream = function (logFH) {
        this.logStream = logFH;
    };
    Logger.prototype.setDebugLogging = function (debugLog) {
        this.debugLogging = debugLog;
    };
    Logger.prototype.setLogErrorsToRedis = function (logErrorsToRedis) {
        this.logErrorsToRedis = logErrorsToRedis;
    };
    Logger.prototype.setLogLevel = function (logLevels) {
        this.logLevels = logLevels;
    };
    Logger.prototype.setContext = function (contexts) {
        this.contexts = contexts;
    };
    Logger.prototype.setCrawlState = function (crawlState) {
        this.crawlState = crawlState;
    };
    Logger.prototype.logAsJSON = function (message, data, context, logLevel) {
        if (logLevel === void 0) { logLevel = "info"; }
        if (data instanceof Error) {
            data = errJSON(data);
        }
        else if (typeof data !== "object") {
            data = { "message": data.toString() };
        }
        if (this.logLevels.length) {
            if (this.logLevels.indexOf(logLevel) < 0) {
                return;
            }
        }
        if (this.contexts.length) {
            if (this.contexts.indexOf(context) < 0) {
                return;
            }
        }
        var dataToLog = {
            "timestamp": new Date().toISOString(),
            "logLevel": logLevel,
            "context": context,
            "message": message,
            "details": data ? data : {}
        };
        var string = JSON.stringify(dataToLog);
        console.log(string);
        if (this.logStream) {
            this.logStream.write(string + "\n");
        }
        var toLogToRedis = ["error", "fatal"];
        if (this.logErrorsToRedis && toLogToRedis.includes(logLevel)) {
            this.crawlState.logError(string);
        }
    };
    Logger.prototype.info = function (message, data, context) {
        if (data === void 0) { data = {}; }
        if (context === void 0) { context = "general"; }
        this.logAsJSON(message, data, context);
    };
    Logger.prototype.error = function (message, data, context) {
        if (data === void 0) { data = {}; }
        if (context === void 0) { context = "general"; }
        this.logAsJSON(message, data, context, "error");
    };
    Logger.prototype.warn = function (message, data, context) {
        if (data === void 0) { data = {}; }
        if (context === void 0) { context = "general"; }
        this.logAsJSON(message, data, context, "warn");
    };
    Logger.prototype.debug = function (message, data, context) {
        if (data === void 0) { data = {}; }
        if (context === void 0) { context = "general"; }
        if (this.debugLogging) {
            this.logAsJSON(message, data, context, "debug");
        }
    };
    Logger.prototype.fatal = function (message, data, context, exitCode) {
        if (data === void 0) { data = {}; }
        if (context === void 0) { context = "general"; }
        if (exitCode === void 0) { exitCode = 17; }
        this.logAsJSON("".concat(message, ". Quitting"), data, context, "fatal");
        function markFailedAndEnd(crawlState) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, crawlState.setStatus("failed")];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, crawlState.setEndTime()];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        }
        if (this.crawlState) {
            markFailedAndEnd(this.crawlState)["finally"](process.exit(exitCode));
        }
        else {
            process.exit(exitCode);
        }
    };
    return Logger;
}());
exports.logger = new Logger();
