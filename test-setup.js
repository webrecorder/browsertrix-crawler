import { jest } from "@jest/globals";
import { getDiskUsage } from "./util/storage.js";

global.jest = jest;
global.getDiskUsage = getDiskUsage;
