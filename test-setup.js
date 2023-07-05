import { jest } from "@jest/globals";
import { getDiskUsage } from "./utils/storage.js";

global.jest = jest;
global.getDiskUsage = getDiskUsage;
