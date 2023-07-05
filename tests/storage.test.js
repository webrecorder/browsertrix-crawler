import { calculatePercentageUsed, checkDiskUtilization, getDiskUsage } from "../util/storage.js";

test("ensure calculatePercentageUsed returns expected values", () => {
  expect(calculatePercentageUsed(30, 100)).toEqual(30);

  expect(calculatePercentageUsed(1507, 35750)).toEqual(4);

  expect(calculatePercentageUsed(33819, 35750)).toEqual(95);

  expect(calculatePercentageUsed(140, 70)).toEqual(200);

  expect(calculatePercentageUsed(0, 5)).toEqual(0);
});


jest.mock(getDiskUsage, () => jest.fn());

test("verify end-to-end disk utilization check works as expected with mock df return", async () => {
  const params = {
    diskUtilization: 90,
    combineWARC: true,
    generateWACZ: true
  };

  getDiskUsage.mockImplementation(() => `Filesystem     1K-blocks      Used Available Use% Mounted on
grpcfuse       971350180 270314600 701035580  28% /crawls`);

  const returnValue = await checkDiskUtilization(params, 7500000);
  expect(returnValue).toEqual({
    stop: false,
    used: 28,
    projected: 31,
    threshold: 90
  });
});
