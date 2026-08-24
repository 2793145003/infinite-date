import React from 'react';
import { CharacterEditScreen } from './CharacterEditScreen';
import { Character } from '../types';

interface EditCharacterModalProps {
  character?: Character | null;
  onClose: () => void;
  onSave: (characterData: Partial<Character>) => void;
}

export const EditCharacterModal: React.FC<EditCharacterModalProps> = ({
  character,
  onClose,
  onSave,
}) => {
  return (
    <CharacterEditScreen
      character={character}
      onBack={onClose}
      onSave={onSave}
    />
  );
};
