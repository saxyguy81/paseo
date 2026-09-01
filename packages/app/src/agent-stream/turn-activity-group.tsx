import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface TurnActivityGroupViewProps {
  groupId: string;
  itemCount: number;
  expanded: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children?: ReactNode;
}

function disclosureStyle({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.disclosure,
    hovered ? styles.disclosureHovered : null,
    pressed ? styles.disclosurePressed : null,
  ];
}

export function TurnActivityGroupView({
  groupId,
  itemCount,
  expanded,
  onExpandedChange,
  children,
}: TurnActivityGroupViewProps) {
  const { t } = useTranslation();
  const label = t(expanded ? "agentStream.activityGroup.hide" : "agentStream.activityGroup.show", {
    count: itemCount,
  });
  const handlePress = useCallback(
    () => onExpandedChange(groupId, !expanded),
    [expanded, groupId, onExpandedChange],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  // React Native Web does not map accessibilityState.expanded to aria-expanded.
  const webDisclosureState = isWeb ? ({ "aria-expanded": expanded } as const) : null;

  return (
    <View>
      <Pressable
        style={disclosureStyle}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        {...webDisclosureState}
        testID={`turn-activity-group-${groupId}`}
      >
        {expanded ? (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
        )}
        <Text style={styles.label}>{label}</Text>
      </Pressable>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  disclosure: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  disclosureHovered: {
    backgroundColor: theme.colors.surface1,
  },
  disclosurePressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  body: {
    paddingTop: theme.spacing[1],
  },
}));
