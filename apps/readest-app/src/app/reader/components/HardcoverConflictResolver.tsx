import React from 'react';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { HardcoverSyncDetails } from '../hooks/useHardcoverSync';

interface HardcoverConflictResolverProps {
  details: HardcoverSyncDetails | null;
  onResolveWithLocal: () => void;
  onResolveWithRemote: () => void;
  onClose: () => void;
}

const HardcoverConflictResolver: React.FC<HardcoverConflictResolverProps> = ({
  details,
  onResolveWithLocal,
  onResolveWithRemote,
  onClose,
}) => {
  const _ = useTranslation();

  if (!details) return null;

  return (
    <Dialog isOpen={true} onClose={onClose} title={_('Sync Conflict')}>
      <p className='py-4 text-center'>{_('Sync reading progress from Hardcover?')}</p>
      <div className='mt-4 space-y-4'>
        <button
          className='btn h-auto w-full flex-col items-start py-2'
          onClick={onResolveWithLocal}
        >
          <span>{_('Local Progress')}</span>
          <span className='text-base-content/50 text-xs font-normal normal-case'>
            {details.conflict.local.preview}
          </span>
        </button>
        <button
          className='btn btn-primary h-auto w-full flex-col items-start py-2'
          onClick={onResolveWithRemote}
        >
          <span>{_('Hardcover Progress')}</span>
          <span className='text-xs font-normal normal-case'>{details.conflict.remote.preview}</span>
        </button>
      </div>
    </Dialog>
  );
};

export default HardcoverConflictResolver;
