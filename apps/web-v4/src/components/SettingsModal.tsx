import React from 'react';
import { PersonalSettingsScreen } from './PersonalSettingsScreen';
import { Character } from '../types';

interface SettingsModalProps {
  activeCharacter: Character;
  onClose: () => void;
  onResetData: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  activeCharacter,
  onClose,
  onResetData,
}) => {
  return (
    <PersonalSettingsScreen
      activeCharacter={activeCharacter}
      onBack={onClose}
      onResetData={onResetData}
    />
  );
};
