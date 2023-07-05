import { jest } from "@jest/globals";

import * as storage from "../util/storage.js";

test("ensure calculatePercentageUsed returns expected values", () => {
  expect(storage.calculatePercentageUsed(30, 100)).toEqual(30);

  expect(storage.calculatePercentageUsed(1507, 35750)).toEqual(4);

  expect(storage.calculatePercentageUsed(33819, 35750)).toEqual(95);

  expect(storage.calculatePercentageUsed(140, 70)).toEqual(200);

  expect(storage.calculatePercentageUsed(0, 5)).toEqual(0);
});


storage.getDiskUsage = jest.fn().mockReturnValue(`Filesystem     1K-blocks      Used Available Use% Mounted on
grpcfuse       971350180 270314600 701035580  28% /crawls`);

test("verify end-to-end disk utilization check works as expected with mock df return", async () => {
  const params = {
    diskUtilization: 90,
    combineWARC: true,
    generateWACZ: true
  };

  const returnValue = await storage.checkDiskUtilization(params, 7500000);
  expect(returnValue).toEqual({
    stop: false,
    used: 28,
    projected: 31,
    threshold: 90
  });
});
