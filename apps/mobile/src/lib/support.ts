import { Alert, Linking } from 'react-native';
import { config } from '@/config';

/**
 * Opens a support email (`config.supportEmail`) with the subject and, when known, the username in the body. Falls
 * back to an alert with the address when nothing can handle `mailto:` (no mail app set up, simulators).
 */
export function openSupportMail(subject: string, username?: string | null): void {
  const body = username ? `Username: ${username}\n\n` : '';
  Linking.openURL(
    `mailto:${config.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  ).catch(() => Alert.alert('No email app', `Write to ${config.supportEmail} from any email app.`));
}
