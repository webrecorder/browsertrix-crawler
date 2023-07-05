import { jest } from "@jest/globals";
import { calculatePercentageUsed, checkDiskUtilization } from "../util/storage.js";


test("ensure calculatePercentageUsed returns expected values", () => {
  expect(calculatePercentageUsed(30, 100)).toEqual(30);

  expect(calculatePercentageUsed(1507, 35750)).toEqual(4);

  expect(calculatePercentageUsed(33819, 35750)).toEqual(95);

  expect(calculatePercentageUsed(140, 70)).toEqual(200);

  expect(calculatePercentageUsed(0, 5)).toEqual(0);
});


test("verify end-to-end disk utilization not exceeded threshold", async () => {

  const params = {
    diskUtilization: 90,
    combineWARC: true,
    generateWACZ: true
  };

 const mockDfOutput = `\
Filesystem     1K-blocks      Used Available Use% Mounted on
grpcfuse       971350180 270314600 701035580  28% /crawls`;

  const returnValue = await checkDiskUtilization(params, 7500000 * 1024, mockDfOutput);
  expect(returnValue).toEqual({
    stop: false,
    used: 28,
    projected: 31,
    threshold: 90
  });
});


test("verify end-to-end disk utilization exceeds threshold", async () => {

  const params = {
    diskUtilization: 90,
    combineWARC: false,
    generateWACZ: true
  };

 const mockDfOutput = `\
Filesystem     1K-blocks  Used Available Use% Mounted on
grpcfuse       100000    85000     15000  85% /crawls`;

  const returnValue = await checkDiskUtilization(params, 3000 * 1024, mockDfOutput);
  expect(returnValue).toEqual({
    stop: true,
    used: 85,
    projected: 91,
    threshold: 90
  });
});
