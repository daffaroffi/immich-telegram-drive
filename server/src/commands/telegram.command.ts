import { Command, CommandRunner, InquirerService, Question, QuestionSet } from 'nest-commander';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

@QuestionSet({ name: 'telegram-phone' })
export class TelegramPhoneQuestions {
  @Question({
    type: 'input',
    name: 'phone',
    message: 'Telegram phone number (international format, e.g. +628123456789)',
  })
  parsePhone(value: string): string {
    return value;
  }
}

@QuestionSet({ name: 'telegram-code' })
export class TelegramCodeQuestions {
  @Question({
    type: 'input',
    name: 'code',
    message: 'Login code received in Telegram',
  })
  parseCode(value: string): string {
    return value;
  }
}

@Command({
  name: 'telegram:login',
  description: 'Create the Telegram MTProto session used by telegram storage (interactive, run once)',
})
export class TelegramLoginCommand extends CommandRunner {
  constructor(
    private configRepository: ConfigRepository,
    private mtproto: TelegramMtprotoService,
    private inquirer: InquirerService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const config = this.configRepository.getEnv().telegram;
    if (!config.enabled) {
      console.error('TELEGRAM_STORAGE_ENABLED is not set; enable telegram storage first');
      return;
    }

    const path = await this.mtproto.interactiveLogin(
      async () => {
        const { phone } = await this.inquirer.ask<{ phone: string }>('telegram-phone', {});
        return phone;
      },
      async () => {
        const { code } = await this.inquirer.ask<{ code: string }>('telegram-code', {});
        return code;
      },
    );

    console.log(`Telegram session written to ${path}`);
  }
}

@Command({
  name: 'telegram:keygen',
  description: 'Generate a TELEGRAM_VAULT_KEY value (32 random bytes hex)',
})
export class TelegramKeygenCommand extends CommandRunner {
  constructor(
    private crypto: TelegramCryptoService,
    private configRepository: ConfigRepository,
  ) {
    super();
  }

  async run(): Promise<void> {
    const key = this.crypto.generateVaultKey();
    const existing = this.configRepository.getEnv().telegram.vaultKey;
    console.log(`TELEGRAM_VAULT_KEY=${key}`);
    if (existing) {
      console.warn(
        'A key is already configured. Replacing it makes previously uploaded files unrecoverable unless the old key is kept.',
      );
    }
  }
}
