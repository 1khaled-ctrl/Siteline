import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

// English only for now; strings stay in en.json so Arabic can be added back as ar.json.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
