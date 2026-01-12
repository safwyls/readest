import clsx from 'clsx';
import React, { useState, useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { HardcoverClient, getHardcoverCircuitState, resetHardcoverCircuitBreaker } from '@/services/sync/HardcoverClient';
import { HardcoverSyncStrategy, HardcoverSyncFrequency } from '@/types/settings';
import Dialog from '@/components/Dialog';

type Option = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: Option[];
  disabled?: boolean;
  className?: string;
};

const StyledSelect: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  className,
  disabled = false,
}) => {
  return (
    <select
      value={value}
      onChange={onChange}
      className={clsx(
        'select select-bordered h-12 w-full text-sm focus:outline-none focus:ring-0',
        className,
      )}
      disabled={disabled}
    >
      {options.map(({ value, label, disabled = false }) => (
        <option key={value} value={value} disabled={disabled}>
          {label}
        </option>
      ))}
    </select>
  );
};

export const setHardcoverSettingsWindowVisible = (visible: boolean) => {
  const dialog = document.getElementById('hardcover_settings_window');
  if (dialog) {
    const event = new CustomEvent('setHardcoverSettingsVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

export const HardcoverSettingsWindow: React.FC = () => {
  const _ = useTranslation();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { envConfig } = useEnv();

  const [isOpen, setIsOpen] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [circuitState, setCircuitState] = useState(getHardcoverCircuitState());

  const isConfigured = !!settings.hardcover?.apiToken;

  // Poll circuit breaker state every second to update countdown
  useEffect(() => {
    if (!isOpen) return;

    const interval = setInterval(() => {
      setCircuitState(getHardcoverCircuitState());
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) {
        setApiToken(settings.hardcover?.apiToken || '');
        setCircuitState(getHardcoverCircuitState()); // Refresh circuit state
      }
    };
    const el = document.getElementById('hardcover_settings_window');
    el?.addEventListener('setHardcoverSettingsVisibility', handleCustomEvent as EventListener);
    return () => {
      el?.removeEventListener(
        'setHardcoverSettingsVisibility',
        handleCustomEvent as EventListener,
      );
    };
  }, [settings.hardcover?.apiToken]);

  const handleConnect = async () => {
    setIsConnecting(true);

    const config = {
      ...settings.hardcover,
      apiToken,
      enabled: true,
    };

    const client = new HardcoverClient(config);
    const result = await client.testConnection();

    if (result.success) {
      const newSettings = {
        ...settings,
        hardcover: config,
      };
      setSettings(newSettings);
      await saveSettings(envConfig, newSettings);
      eventDispatcher.dispatch('toast', {
        message: _('Connected to Hardcover'),
        type: 'success',
      });
    } else {
      eventDispatcher.dispatch('toast', {
        message: `${_('Failed to connect')}: ${_(result.message || 'Connection error')}`,
        type: 'error',
      });
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    const hardcover = {
      ...settings.hardcover,
      apiToken: '',
      enabled: false,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
    eventDispatcher.dispatch('toast', { message: _('Disconnected'), type: 'info' });
  };

  const handleStrategyChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const hardcover = {
      ...settings.hardcover,
      strategy: e.target.value as HardcoverSyncStrategy,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleToggleSyncProgress = async () => {
    const hardcover = {
      ...settings.hardcover,
      syncProgress: !settings.hardcover.syncProgress,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleToggleSyncStatus = async () => {
    const hardcover = {
      ...settings.hardcover,
      syncStatus: !settings.hardcover.syncStatus,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleToggleDebug = async () => {
    const hardcover = {
      ...settings.hardcover,
      debug: !settings.hardcover.debug,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleSyncFrequencyChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const hardcover = {
      ...settings.hardcover,
      syncFrequency: e.target.value as HardcoverSyncFrequency,
    };
    const newSettings = { ...settings, hardcover };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleResetCircuitBreaker = () => {
    resetHardcoverCircuitBreaker();
    setCircuitState(getHardcoverCircuitState());
    eventDispatcher.dispatch('toast', {
      message: _('Circuit breaker reset'),
      type: 'success',
    });
  };

  const getCircuitStateDisplay = () => {
    switch (circuitState.state) {
      case 'CLOSED':
        return { text: _('Normal'), color: 'text-success' };
      case 'OPEN':
        const timeLeft = Math.max(
          0,
          Math.ceil((60000 - (Date.now() - circuitState.lastFailureTime)) / 1000),
        );
        return {
          text: _('Open (retry in {{seconds}}s)', { seconds: timeLeft }),
          color: 'text-error',
        };
      case 'HALF_OPEN':
        return { text: _('Testing recovery'), color: 'text-warning' };
      default:
        return { text: _('Unknown'), color: 'text-base-content/60' };
    }
  };

  const circuitDisplay = getCircuitStateDisplay();

  return (
    <Dialog
      id='hardcover_settings_window'
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      title={_('Hardcover Sync Settings')}
      boxClassName='sm:!min-w-[520px] sm:h-auto'
    >
      {isOpen && (
        <div className='mb-4 mt-0 flex flex-col gap-4 p-2 sm:p-4'>
          {isConfigured ? (
            <>
              <div className='text-center'>
                <p className='text-base-content/80 text-sm'>{_('Connected to Hardcover')}</p>
              </div>

              <div className='flex h-14 items-center justify-between'>
                <span className='text-base-content/80'>{_('Hardcover Sync Enabled')}</span>
                <input
                  type='checkbox'
                  className='toggle'
                  checked={settings.hardcover.enabled}
                  onChange={() => handleDisconnect()}
                />
              </div>

              <div className='form-control w-full'>
                <label className='label py-1'>
                  <span className='label-text font-medium'>{_('Sync Strategy')}</span>
                </label>
                <StyledSelect
                  value={settings.hardcover.strategy}
                  onChange={handleStrategyChange}
                  options={[
                    { value: 'prompt', label: _('Ask on conflict') },
                    { value: 'silent', label: _('Always use latest') },
                    { value: 'send', label: _('Send changes only') },
                    { value: 'receive', label: _('Receive changes only') },
                  ]}
                />
              </div>

              <div className='form-control w-full'>
                <label className='label py-1'>
                  <span className='label-text font-medium'>{_('Sync Frequency')}</span>
                </label>
                <StyledSelect
                  value={settings.hardcover.syncFrequency}
                  onChange={handleSyncFrequencyChange}
                  options={[
                    { value: 'page', label: _('On page turn (every 5s)') },
                    { value: 'chapter', label: _('On chapter change') },
                    { value: 'session', label: _('On open/close only') },
                  ]}
                />
              </div>

              <div className='flex h-14 items-center justify-between'>
                <span className='text-base-content/80'>{_('Sync Reading Progress')}</span>
                <input
                  type='checkbox'
                  className='toggle'
                  checked={settings.hardcover.syncProgress}
                  onChange={handleToggleSyncProgress}
                />
              </div>

              <div className='flex h-14 items-center justify-between'>
                <span className='text-base-content/80'>{_('Sync Reading Status')}</span>
                <input
                  type='checkbox'
                  className='toggle'
                  checked={settings.hardcover.syncStatus}
                  onChange={handleToggleSyncStatus}
                />
              </div>

              <div className='flex h-14 items-center justify-between'>
                <span className='text-base-content/80'>{_('Debug Logging')}</span>
                <input
                  type='checkbox'
                  className='toggle toggle-sm'
                  checked={settings.hardcover.debug}
                  onChange={handleToggleDebug}
                />
              </div>

              <div className='divider my-2'></div>

              <div className='rounded-lg bg-base-200 p-3'>
                <div className='mb-2 flex items-center justify-between'>
                  <span className='text-sm font-medium'>{_('Circuit Breaker Status')}</span>
                  {circuitState.state === 'OPEN' && (
                    <button
                      className='btn btn-xs btn-outline'
                      onClick={handleResetCircuitBreaker}
                    >
                      {_('Reset')}
                    </button>
                  )}
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-xs text-base-content/70'>{_('State:')}</span>
                  <span className={clsx('text-xs font-semibold', circuitDisplay.color)}>
                    {circuitDisplay.text}
                  </span>
                </div>
                {circuitState.failureCount > 0 && circuitState.state !== 'OPEN' && (
                  <div className='mt-1 flex items-center justify-between'>
                    <span className='text-xs text-base-content/70'>{_('Failures:')}</span>
                    <span className='text-xs text-warning'>
                      {circuitState.failureCount}/3
                    </span>
                  </div>
                )}
              </div>

              <p className='text-base-content/60 text-center text-xs'>
                {_('Get your API token from')}{' '}
                <a
                  href='https://hardcover.app/account/api'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='link'
                >
                  hardcover.app/account/api
                </a>
              </p>
            </>
          ) : (
            <>
              <p className='text-base-content/70 text-center text-sm'>
                {_('Connect to Hardcover to sync your reading progress.')}
              </p>

              <div className='form-control w-full'>
                <label className='label py-1'>
                  <span className='label-text font-medium'>{_('API Token')}</span>
                </label>
                <input
                  type='password'
                  placeholder={_('Paste your Hardcover API token')}
                  className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  autoComplete='off'
                />
              </div>

              <p className='text-base-content/60 text-xs'>
                {_('Get your API token from')}{' '}
                <a
                  href='https://hardcover.app/account/api'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='link'
                >
                  hardcover.app/account/api
                </a>
              </p>

              <button
                className='btn btn-primary mt-2 h-12 min-h-12 w-full'
                onClick={handleConnect}
                disabled={isConnecting || !apiToken}
              >
                {isConnecting ? <span className='loading loading-spinner'></span> : _('Connect')}
              </button>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
};
