import { SystemMetadataKey } from 'src/enum.js';
import { Resource } from 'src/resource-paths.js';
import { ServerService } from 'src/services/server.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { mockAdmins } from 'test/repositories/user.repository.mock.js';
import { ServiceMocks, expectResourceEvents, newTestService } from 'test/utils.js';

describe(ServerService.name, () => {
  let sut: ServerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ServerService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getStorage', () => {
    it('should report telegram storage when no cache is set yet', async () => {
      mocks.telegramRef.totalBytes.mockResolvedValue(1_000_000);

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '0 B',
        diskAvailableRaw: 0,
        diskSize: '976.6 KiB',
        diskSizeRaw: 1_000_000,
        diskUsagePercentage: 100,
        diskUse: '976.6 KiB',
        diskUseRaw: 1_000_000,
      });

      expect(mocks.telegramRef.totalBytes).toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.TelegramStorage);
    });

    it('should add the cached pending bytes to the total', async () => {
      mocks.telegramRef.totalBytes.mockResolvedValue(1_000_000);
      mocks.systemMetadata.get.mockResolvedValue({
        pendingBytes: 2_000_000,
        pendingCount: 10,
        updatedAt: '2026-11-24T12:00:00.000Z',
      });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '1.9 MiB',
        diskAvailableRaw: 2_000_000,
        diskSize: '2.9 MiB',
        diskSizeRaw: 3_000_000,
        diskUsagePercentage: 33.33,
        diskUse: '976.6 KiB',
        diskUseRaw: 1_000_000,
      });
    });

    it('should treat a stale negative cache as zero', async () => {
      mocks.telegramRef.totalBytes.mockResolvedValue(500);
      mocks.systemMetadata.get.mockResolvedValue({ pendingBytes: -1, pendingCount: 0, updatedAt: 'x' });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '0 B',
        diskAvailableRaw: 0,
        diskSize: '500 B',
        diskSizeRaw: 500,
        diskUsagePercentage: 100,
        diskUse: '500 B',
        diskUseRaw: 500,
      });
    });
  });

  describe('ping', () => {
    it('should respond with pong', () => {
      expect(sut.ping()).toEqual({ res: 'pong' });
    });
  });

  describe('getFeatures', () => {
    it('should respond the server features', async () => {
      await expect(sut.getFeatures()).resolves.toEqual({
        smartSearch: true,
        duplicateDetection: true,
        facialRecognition: true,
        importFaces: false,
        backups: false,
        map: true,
        reverseGeocoding: true,
        oauth: false,
        oauthAutoLaunch: false,
        ocr: true,
        passwordLogin: true,
        search: true,
        sidecar: true,
        configFile: false,
        trash: true,
        email: false,
        realtimeTranscoding: false,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });
  });

  describe('getSystemConfig', () => {
    it('should respond the server configuration', async () => {
      await expect(sut.getSystemConfig()).resolves.toEqual({
        loginPageMessage: '',
        oauthButtonText: 'Login with OAuth',
        oauthAccountManagementUrl: '',
        trashDays: 30,
        userDeleteDelay: 7,
        isInitialized: false,
        isOnboarded: false,
        externalDomain: '',
        publicUsers: true,
        mapDarkStyleUrl: 'https://tiles.immich.cloud/v1/style/dark.json',
        mapLightStyleUrl: 'https://tiles.immich.cloud/v1/style/light.json',
        maintenanceMode: false,
        minFaces: 3,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should be initialized once an admin exists', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });

    it('should be initialized when setup is disabled', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ setup: { allow: false } }));
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });
  });

  describe('getStats', () => {
    it('should total up usage by user', async () => {
      mocks.user.getUserStats.mockResolvedValue([
        {
          userId: 'user1',
          userName: '1 User',
          photos: 10,
          videos: 11,
          usage: 12_345,
          usagePhotos: 1,
          usageVideos: 11_345,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user2',
          userName: '2 User',
          photos: 10,
          videos: 20,
          usage: 123_456,
          usagePhotos: 100,
          usageVideos: 23_456,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user3',
          userName: '3 User',
          photos: 100,
          videos: 0,
          usage: 987_654,
          usagePhotos: 900,
          usageVideos: 87_654,
          quotaSizeInBytes: 0,
        },
      ]);

      await expect(sut.getStatistics()).resolves.toEqual({
        photos: 120,
        videos: 31,
        usage: 1_123_455,
        usagePhotos: 1001,
        usageVideos: 122_455,
        usageByUser: [
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 12_345,
            usagePhotos: 1,
            usageVideos: 11_345,
            userName: '1 User',
            userId: 'user1',
            videos: 11,
          },
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 123_456,
            usagePhotos: 100,
            usageVideos: 23_456,
            userName: '2 User',
            userId: 'user2',
            videos: 20,
          },
          {
            photos: 100,
            quotaSizeInBytes: 0,
            usage: 987_654,
            usagePhotos: 900,
            usageVideos: 87_654,
            userName: '3 User',
            userId: 'user3',
            videos: 0,
          },
        ],
      });

      expect(mocks.user.getUserStats).toHaveBeenCalled();
    });
  });

  describe('setLicense', () => {
    it('should save license if valid', async () => {
      mocks.systemMetadata.set.mockResolvedValue();
      mocks.user.getAdminIds.mockResolvedValue([]);

      const license = { licenseKey: 'IMSV-license-key', activationKey: 'activation-key' };
      await sut.setLicense(license);

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.License, expect.any(Object));
    });

    it('should tell every admin about the new license', async () => {
      const adminIds = mockAdmins(mocks.user);
      mocks.systemMetadata.set.mockResolvedValue();

      await sut.setLicense({ licenseKey: 'IMSV-license-key', activationKey: 'activation-key' });

      expectResourceEvents(mocks, { userIds: adminIds, changed: [Resource.serverLicense(), Resource.serverAbout()] });
    });

    it('should not save license if invalid', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();

      const license = { licenseKey: 'license-key', activationKey: 'activation-key' };
      const call = sut.setLicense(license);
      await expect(call).rejects.toThrowError('Invalid license key');
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.resource.send).not.toHaveBeenCalled();
    });
  });

  describe('deleteLicense', () => {
    it('should delete license', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();
      mocks.user.getAdminIds.mockResolvedValue([]);

      await sut.deleteLicense();
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it('should tell every admin about the removed license', async () => {
      const adminIds = mockAdmins(mocks.user);
      mocks.systemMetadata.delete.mockResolvedValue();

      await sut.deleteLicense();

      expectResourceEvents(mocks, { userIds: adminIds, changed: [Resource.serverLicense(), Resource.serverAbout()] });
    });
  });
});
