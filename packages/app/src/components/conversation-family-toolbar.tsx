import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { searchConversationFamily } from "@/conversation-family";
import type { ConversationFamilyView } from "@/hooks/use-conversation-family";
import type { Theme } from "@/styles/theme";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function resolveConversationFamilySearchVisibility(input: {
  isCompactFormFactor: boolean;
  isCompactExpanded: boolean;
}): boolean {
  return !input.isCompactFormFactor || input.isCompactExpanded;
}

export function ConversationFamilyToolbar({
  family,
  isExpanded,
  onExpandedChange,
  onJumpToMatch,
}: {
  family: ConversationFamilyView;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onJumpToMatch: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const [query, setQuery] = useState("");
  const [includeToolActivity, setIncludeToolActivity] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const matches = useMemo(
    () =>
      searchConversationFamily(family.streamItems, query, {
        includeToolActivity,
      }),
    [family.streamItems, includeToolActivity, query],
  );
  const isSearchVisible = resolveConversationFamilySearchVisibility({
    isCompactFormFactor,
    isCompactExpanded: isExpanded,
  });

  useEffect(() => setActiveMatchIndex(0), [includeToolActivity, matches.length, query]);

  const jumpToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const normalized = (index + matches.length) % matches.length;
      setActiveMatchIndex(normalized);
      onJumpToMatch(matches[normalized].itemId);
    },
    [matches, onJumpToMatch],
  );
  const hasMatches = matches.length > 0;
  const matchNavigationAccessibilityState = useMemo(
    () => ({ disabled: !hasMatches }),
    [hasMatches],
  );
  const matchCountLabel = useMemo(() => {
    if (query.trim().length === 0) return "";
    if (!hasMatches) return t("agentStream.family.noMatches");
    return t("agentStream.family.matchCount", {
      current: Math.min(activeMatchIndex + 1, matches.length),
      total: matches.length,
    });
  }, [activeMatchIndex, hasMatches, matches.length, query, t]);
  const jumpToPreviousMatch = useCallback(
    () => jumpToMatch(activeMatchIndex - 1),
    [activeMatchIndex, jumpToMatch],
  );
  const jumpToNextMatch = useCallback(
    () => jumpToMatch(activeMatchIndex + 1),
    [activeMatchIndex, jumpToMatch],
  );
  const toggleCompactSearch = useCallback(
    () => onExpandedChange(!isExpanded),
    [isExpanded, onExpandedChange],
  );
  const fullHistoryLabel = t("agentStream.family.fullHistory", {
    count: family.memberCount,
  });
  const disclosureAccessibilityState = useMemo(
    () => ({ expanded: isSearchVisible }),
    [isSearchVisible],
  );
  const disclosureLeftIcon = useMemo(
    () =>
      family.isLoading ? (
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      ) : null,
    [family.isLoading],
  );
  const disclosureTrailing = useMemo(
    () =>
      isSearchVisible ? (
        <ThemedChevronUp size={14} uniProps={foregroundMutedColorMapping} />
      ) : (
        <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
      ),
    [isSearchVisible],
  );
  // React Native Web does not map accessibilityState.expanded to aria-expanded.
  const webDisclosureState = isWeb ? ({ "aria-expanded": isSearchVisible } as const) : null;

  return (
    <View
      style={[styles.familyToolbarRail, isCompactFormFactor && styles.familyToolbarRailCompact]}
      testID="conversation-family-toolbar"
    >
      <View style={styles.familyToolbar}>
        <View style={[styles.familySummary, isCompactFormFactor && styles.familySummaryCompact]}>
          {isCompactFormFactor ? (
            <Button
              {...webDisclosureState}
              size="xs"
              variant="ghost"
              hitSlop={8}
              style={styles.familyDisclosureButton}
              textStyle={styles.familyDisclosureText}
              leftIcon={disclosureLeftIcon}
              trailing={disclosureTrailing}
              onPress={toggleCompactSearch}
              accessibilityLabel={fullHistoryLabel}
              accessibilityState={disclosureAccessibilityState}
              testID="conversation-family-disclosure"
            >
              {fullHistoryLabel}
            </Button>
          ) : (
            <>
              {family.isLoading ? (
                <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
              ) : null}
              <Text style={styles.familySummaryText} numberOfLines={1}>
                {fullHistoryLabel}
              </Text>
            </>
          )}
          {family.error ? (
            <Text style={styles.familyErrorText} numberOfLines={1}>
              {t("agentStream.family.loadFailed")}
            </Text>
          ) : null}
        </View>
        {isSearchVisible ? (
          <View
            style={[styles.familySearchRow, isCompactFormFactor && styles.familySearchRowCompact]}
          >
            <View
              style={[
                styles.familySearchField,
                isCompactFormFactor && styles.familySearchFieldCompact,
              ]}
            >
              <SearchField
                value={query}
                onChangeText={setQuery}
                placeholder={t("agentStream.family.searchPlaceholder")}
                clearAccessibilityLabel={t("agentStream.family.clearSearch")}
                testID="conversation-family-search"
                clearTestID="conversation-family-search-clear"
              />
            </View>
            <View
              style={[
                styles.familySearchControls,
                isCompactFormFactor && styles.familySearchControlsCompact,
              ]}
            >
              <Text style={styles.familyMatchCount} testID="conversation-family-match-count">
                {matchCountLabel}
              </Text>
              <Pressable
                style={styles.familyNavButton}
                disabled={!hasMatches}
                onPress={jumpToPreviousMatch}
                accessibilityRole="button"
                accessibilityLabel={t("agentStream.family.previousMatch")}
                accessibilityState={matchNavigationAccessibilityState}
                testID="conversation-family-previous"
              >
                <ThemedChevronUp size={16} uniProps={foregroundMutedColorMapping} />
              </Pressable>
              <Pressable
                style={styles.familyNavButton}
                disabled={!hasMatches}
                onPress={jumpToNextMatch}
                accessibilityRole="button"
                accessibilityLabel={t("agentStream.family.nextMatch")}
                accessibilityState={matchNavigationAccessibilityState}
                testID="conversation-family-next"
              >
                <ThemedChevronDown size={16} uniProps={foregroundMutedColorMapping} />
              </Pressable>
              <View style={styles.familyToolToggle}>
                <Text style={styles.familyToolToggleText}>
                  {t("agentStream.family.includeTools")}
                </Text>
                <Switch
                  value={includeToolActivity}
                  onValueChange={setIncludeToolActivity}
                  accessibilityLabel={t("agentStream.family.includeTools")}
                  testID="conversation-family-include-tools"
                />
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  familyToolbarRail: {
    width: "100%",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingVertical: theme.spacing[2],
  },
  familyToolbar: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    gap: theme.spacing[2],
  },
  familyToolbarRailCompact: {
    paddingVertical: 0,
  },
  familySummary: {
    minHeight: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  familySummaryCompact: {
    minHeight: 28,
    flexDirection: "column",
    alignItems: "stretch",
  },
  familySummaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  familyDisclosureButton: {
    flex: 1,
    minWidth: 0,
    justifyContent: "space-between",
    paddingHorizontal: 0,
  },
  familyDisclosureText: {
    color: theme.colors.foregroundMuted,
  },
  familyErrorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  familySearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  familySearchRowCompact: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  familySearchField: {
    flex: 1,
    minWidth: 0,
    maxWidth: 420,
  },
  familySearchFieldCompact: {
    width: "100%",
    maxWidth: "100%",
  },
  familySearchControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  familySearchControlsCompact: {
    width: "100%",
    justifyContent: "flex-end",
  },
  familyMatchCount: {
    minWidth: 54,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  familyNavButton: {
    width: {
      xs: 48,
      md: 32,
    },
    height: {
      xs: 48,
      md: 32,
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  familyToolToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  familyToolToggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
