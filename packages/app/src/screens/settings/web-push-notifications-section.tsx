import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  getWebPushNotificationState,
  unsubscribeBrowserWebPush,
} from "@/push-notifications/web-subscription.web";
import type { WebPushState } from "@/push-notifications/web-subscription-controller";

function stateHint(state: WebPushState | null, hasHost: boolean, t: TFunction): string {
  if (!hasHost) return t("settings.notifications.background.noHost");
  switch (state?.status) {
    case "unsupported":
      return t("settings.notifications.background.unsupported");
    case "unavailable":
      return t("settings.notifications.background.unavailable");
    case "selectedElsewhere":
      return t("settings.notifications.background.selectedElsewhere");
    case "denied":
      return t("settings.notifications.background.denied");
    case "enabled":
      return t("settings.notifications.background.enabled");
    default:
      return t("settings.notifications.background.disabled");
  }
}

/**
 * A web origin owns one PushManager subscription. Settings therefore targets
 * exactly the host currently selected by SettingsScreen rather than scanning
 * every connected daemon and silently registering the first capable one.
 */
export function WebPushNotificationsSection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const runtime = useHostRuntimeSnapshot(serverId ?? "");
  const client = runtime?.connectionStatus === "online" ? runtime.client : null;
  const vapidPublicKey =
    client?.getLastServerInfoMessage()?.features?.webPushNotifications?.vapidPublicKey;
  const [state, setState] = useState<WebPushState | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [hasError, setHasError] = useState(false);

  const refresh = useCallback(() => {
    if (!client) {
      setState(null);
      return;
    }
    void getWebPushNotificationState(client)
      .then(setState)
      .catch(() => setHasError(true));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh, vapidPublicKey]);

  const enabled = state?.status === "enabled";
  let buttonLabel = t("settings.notifications.background.enable");
  if (enabled) buttonLabel = t("settings.notifications.background.disable");
  if (isWorking) buttonLabel = t("settings.notifications.background.working");
  const onPress = useCallback(async () => {
    if (!client) return;
    setIsWorking(true);
    setHasError(false);
    try {
      if (enabled) {
        await disableWebPushNotifications(client);
        await unsubscribeBrowserWebPush();
      } else {
        await enableWebPushNotifications(client);
      }
      refresh();
    } catch {
      setHasError(true);
    } finally {
      setIsWorking(false);
    }
  }, [client, enabled, refresh]);

  const handlePress = useCallback(() => {
    void onPress();
  }, [onPress]);

  return (
    <SettingsSection title={t("settings.notifications.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.notifications.background.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>{stateHint(state, Boolean(client), t)}</Text>
          </View>
          <Button
            variant={enabled ? "outline" : "default"}
            size="sm"
            onPress={handlePress}
            disabled={
              !client ||
              isWorking ||
              state?.status === "unsupported" ||
              state?.status === "denied" ||
              state?.status === "selectedElsewhere"
            }
            accessibilityLabel={t("settings.notifications.background.title")}
            testID="web-push-notifications-toggle"
          >
            {buttonLabel}
          </Button>
        </View>
      </View>
      {hasError ? (
        <Alert
          variant="error"
          title={t("settings.notifications.background.updateFailed")}
          description={t("settings.notifications.background.disabled")}
        />
      ) : null}
    </SettingsSection>
  );
}
