const {
    ActionRowBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
} = require("discord.js");

const { dungeonList } = require("../../utils/loadJson");
const { getMainObject } = require("../../utils/getMainObject");
const { isDPSRole } = require("../../utils/utilFunctions");
const { getEligibleComposition } = require("../../utils/dungeonLogic");
const { sendEmbed } = require("../../utils/sendEmbed");
const { interactionStatusTable } = require("../../utils/loadDb");
const { processError, createStatusEmbed } = require("../../utils/errorHandling");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("lfg")
        .setDescription("Post a message to find a group for your key.")
        .addStringOption((option) =>
            option
                .setName("dungeon")
                .setDescription("Select a dungeon to run.")
                .setRequired(true)
                .addChoices(...dungeonList.map((dungeon) => ({ name: dungeon, value: dungeon })))
        )
        .addStringOption((option) =>
            option
                .setName("time_completion")
                .setDescription("Time/Completion")
                .setRequired(true)
                .addChoices({ name: "time", value: "time" }, { name: "completion", value: "completion" })
        )
        .addStringOption((option) =>
            option
                .setName("listed_as")
                .setDescription("Specify a listed as name for your dungeon. Otherwise one will be generated for you.")
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("creator_notes")
                .setDescription("Add some additional information about your group.")
                .setRequired(false)
        ),
    async execute(interaction) {
        const mainObject = getMainObject(interaction);

        const dungeonToRun = interaction.options.getString("dungeon");
        mainObject.embedData.dungeonName = dungeonToRun;

        const timeOrCompletion = interaction.options.getString("time_completion");
        mainObject.embedData.timeOrCompletion = timeOrCompletion;

        // Set the listed as group name/creator notes if the user specified one
        const listedAs = interaction.options.getString("listed_as");
        if (listedAs) {
            mainObject.embedData.listedAs = listedAs;
        }
        const creatorNotes = interaction.options.getString("creator_notes");
        if (creatorNotes) {
            mainObject.embedData.creatorNotes = creatorNotes;
        }

        // Timeout for the interaction collector
        const timeout = 90_000;

        // Parse key levels from the channel name
        const currentChannel = interaction.channel;
        const channelName = currentChannel.name;
        const channelNameSplit = channelName.split("-");
        const lowerDifficultyRange = parseInt(channelNameSplit[1].replace("m", ""));
        const upperDifficultyRange = lowerDifficultyRange === 21 ? 30 : parseInt(channelNameSplit[2].replace("m", ""));

        // Make a list with dungeon difficulty ranges like +2, +3, +4
        const dungeonDifficultyRanges = [];

        for (let i = lowerDifficultyRange; i <= upperDifficultyRange; i++) {
            dungeonDifficultyRanges.push(i);
        }

        function getSelectDifficultyRow(difficultyPlaceholder) {
            const getSelectDifficulty = new StringSelectMenuBuilder()
                .setCustomId("difficulty")
                .setPlaceholder(difficultyPlaceholder)
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    dungeonDifficultyRanges.map((range) =>
                        new StringSelectMenuOptionBuilder().setLabel(`+${range}`).setValue(`${range}`)
                    )
                );

            const difficultyRow = new ActionRowBuilder().addComponents(getSelectDifficulty);
            return difficultyRow;
        }

        function getSelectUserRoleRow(userRolePlaceholder) {
            const getSelectUserRow = new StringSelectMenuBuilder()
                .setCustomId("userRole")
                .setPlaceholder(userRolePlaceholder)
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel("Tank")
                        .setValue("Tank")
                        .setEmoji(mainObject.roles.Tank.emoji),
                    new StringSelectMenuOptionBuilder()
                        .setLabel("Healer")
                        .setValue("Healer")
                        .setEmoji(mainObject.roles.Healer.emoji),
                    new StringSelectMenuOptionBuilder()
                        .setLabel("DPS")
                        .setValue("DPS")
                        .setEmoji(mainObject.roles.DPS.emoji)
                );

            const userRoleRow = new ActionRowBuilder().addComponents(getSelectUserRow);
            return userRoleRow;
        }

        function getEligibleCompositionRow() {
            const eligibleComposition = getEligibleComposition(mainObject);

            const eligibleCompositionRow = new ActionRowBuilder().addComponents(eligibleComposition);
            return eligibleCompositionRow;
        }

        function getGroupRequirementsRow(groupRequirementsPlaceholder) {
            const getGroupRequirements = new StringSelectMenuBuilder()
                .setCustomId("groupRequirements")
                .setPlaceholder(groupRequirementsPlaceholder)
                .setMaxValues(3)
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel("BL").setValue("BL"),
                    new StringSelectMenuOptionBuilder().setLabel("CR").setValue("CR"),
                    new StringSelectMenuOptionBuilder().setLabel("Dispel").setValue("Disp")
                );

            const groupRequirementsRow = new ActionRowBuilder().addComponents(getGroupRequirements);
            return groupRequirementsRow;
        }

        function getConfirmCancelRow() {
            const confirmSuccess = new ButtonBuilder().setLabel("Create Group").setCustomId("confirm").setStyle(3);
            const confirmCancel = new ButtonBuilder().setLabel("Cancel").setCustomId("cancel").setStyle(4);

            const confirmCancelRow = new ActionRowBuilder().addComponents(confirmSuccess, confirmCancel);
            return confirmCancelRow;
        }

        function getRows(
            difficultyPlaceholder,
            selectUserPlaceholder,
            teamCompositionPlaceholder,
            groupRequirementsPlaceholder
        ) {
            const difficultyRow = getSelectDifficultyRow(difficultyPlaceholder);
            const userRoleRow = getSelectUserRoleRow(selectUserPlaceholder);
            const eligibleCompositionRow = getEligibleCompositionRow(teamCompositionPlaceholder);
            const groupRequirementsRow = getGroupRequirementsRow(groupRequirementsPlaceholder);
            const confirmCancelRow = getConfirmCancelRow();

            return [difficultyRow, userRoleRow, eligibleCompositionRow, groupRequirementsRow, confirmCancelRow];
        }

        // Temporary storage for dropdown values
        let dungeonDifficultyPlaceholder = "Select a difficulty";
        let userChosenRolePlaceholder = "Select your role";
        let dungeonCompositionPlaceholder = "Select your composition";
        let groupRequirementsPlaceholder = "BL, CR, Dispel etc";

        async function updateRows(
            i,
            msgContent,
            dungeonDifficulty,
            userChosenRole,
            dungeonComposition,
            groupRequirements
        ) {
            const [difficultyRow, userRoleRow, eligibleCompositionRow, groupRequirementsRow, confirmCancelRow] =
                getRows(
                    dungeonDifficulty || dungeonDifficultyPlaceholder,
                    userChosenRole || userChosenRolePlaceholder,
                    dungeonComposition || dungeonCompositionPlaceholder,
                    groupRequirements || groupRequirementsPlaceholder
                );

            await i.update({
                content: msgContent,
                ephemeral: true,
                components: [
                    difficultyRow,
                    userRoleRow,
                    eligibleCompositionRow,
                    groupRequirementsRow,
                    confirmCancelRow,
                ],
            });
        }

        const userFilter = (i) => i.user.id === interaction.user.id;

        try {
            const [difficultyRow, userRoleRow, eligibleCompositionRow, groupChangesRow, confirmCancelRow] = getRows(
                dungeonDifficultyPlaceholder,
                userChosenRolePlaceholder,
                dungeonCompositionPlaceholder,
                groupRequirementsPlaceholder
            );

            let messageContent = `You are creating a group for ${dungeonToRun}.`;
            const dungeonResponse = await interaction.reply({
                content: messageContent,
                ephemeral: true,
                components: [difficultyRow, userRoleRow, eligibleCompositionRow, groupChangesRow, confirmCancelRow],
            });

            // Temporary storage for dungeon/group values
            let dungeonDifficulty = null;
            let groupRequirements = null;
            let groupRequirementList = null;
            let userChosenRole = null;
            let dungeonComposition = null;
            let dungeonCompositionList = null;

            // Create a collector for both the drop-down menu and button interactions
            const dungeonCollector = dungeonResponse.createMessageComponentCollector({
                filter: userFilter,
                time: timeout,
            });

            dungeonCollector.on("collect", async (i) => {
                if (i.customId === "difficulty") {
                    dungeonDifficulty = `+${i.values[0]}`;
                    mainObject.embedData.dungeonDifficulty = dungeonDifficulty;

                    await i.deferUpdate();
                } else if (i.customId === "groupRequirements") {
                    groupRequirementList = i.values;
                    groupRequirements = groupRequirementList.join(", ");
                    mainObject.embedData.groupRequirements = groupRequirementList;

                    await i.deferUpdate();
                } else if (i.customId === "userRole") {
                    // Need to reset the composition list if the user changes their role to avoid
                    // the incorrect composition being sent to the embed
                    if (userChosenRole !== i.values[0]) {
                        dungeonCompositionList = null;
                        dungeonComposition = null;
                    }

                    // Add the user's chosen role to the main object so it's easily accessible
                    userChosenRole = i.values[0];
                    mainObject.interactionUser.userChosenRole = userChosenRole;

                    // Update the required composition drop-down based on the user's chosen role
                    await updateRows(
                        i,
                        messageContent,
                        dungeonDifficulty,
                        userChosenRole,
                        dungeonComposition,
                        groupRequirements
                    );
                } else if (i.customId === "composition") {
                    await i.deferUpdate();

                    // Return if the user tries to create a group without selecting their own role
                    if (i.values[0] === "none") {
                        return;
                    }
                    dungeonCompositionList = i.values;
                    dungeonComposition = dungeonCompositionList.join(", ");
                }
                // This is required if user selects the wrong options
                else if (i.customId === "confirm") {
                    // Notify the user if they haven't selected all the required options
                    // With a unique message for each missing option in order of priority
                    let messageContentMissing = messageContent;
                    if (!dungeonDifficulty) {
                        messageContentMissing += "\n**Please select a difficulty.**";
                    } else if (!userChosenRole) {
                        messageContentMissing += "\n**Please select your role.**";
                    } else if (!dungeonComposition) {
                        messageContentMissing += "\n**Please select required roles.**";
                    }

                    if (!dungeonDifficulty || !userChosenRole || !dungeonComposition) {
                        await updateRows(
                            i,
                            messageContentMissing,
                            dungeonDifficulty,
                            userChosenRole,
                            dungeonComposition,
                            groupRequirements
                        );
                    } else {
                        // Add the user to the main object
                        mainObject.roles[userChosenRole].spots.push(mainObject.interactionUser.userId);
                        mainObject.roles[userChosenRole].nicknames.push(mainObject.interactionUser.nickname + " 🚩");

                        // Pull the filled spot from the main object
                        const filledSpot = mainObject.embedData.filledSpot;
                        let filledSpotCounter = 0;

                        for (const role in mainObject.roles) {
                            if (!dungeonCompositionList.includes(role)) {
                                const filledSpotCombined = `${filledSpot}${filledSpotCounter}`;
                                // Add filled members to the spots, except for the user's chosen role
                                if (role !== userChosenRole) {
                                    if (isDPSRole(role)) {
                                        if (mainObject.roles["DPS"].spots.length < 3) {
                                            mainObject.roles["DPS"].spots.push(filledSpotCombined);
                                            mainObject.roles["DPS"].nicknames.push(filledSpot);
                                        }
                                    } else {
                                        mainObject.roles[role].spots.push(filledSpotCombined);
                                        mainObject.roles[role].nicknames.push(filledSpot);
                                    }
                                }

                                if (isDPSRole(role) & (mainObject.roles["DPS"].spots.length >= 3)) {
                                    mainObject.roles["DPS"].disabled = true;
                                } else if (!isDPSRole(role)) {
                                    mainObject.roles[role].disabled = true;
                                }
                                filledSpotCounter++;
                            }
                        }

                        // Update the filled spot counter in the main object
                        mainObject.embedData.filledSpotCounter = filledSpotCounter;

                        const updatedDungeonCompositionList = dungeonCompositionList.map((role) => {
                            return role.startsWith("DPS") ? "DPS" : role;
                        });

                        await i.update({
                            content: `The passphrase for the dungeon is: \`${mainObject.utils.passphrase.phrase}\`\nLook out for NoP members applying with this in-game!`,
                            ephemeral: true,
                            components: [],
                        });

                        await sendEmbed(mainObject, currentChannel, updatedDungeonCompositionList);

                        // Send the created dungeon status to the database
                        await interactionStatusTable.create({
                            interaction_id: interaction.id,
                            interaction_user: interaction.user.id,
                            interaction_status: "created",
                            command_used: "lfg",
                        });

                        dungeonCollector.stop("confirmCreation");
                    }
                } else if (i.customId === "cancel") {
                    dungeonCollector.stop("cancelled");
                }
            });

            dungeonCollector.on("end", async (collected, reason) => {
                if (reason === "time") {
                    await dungeonResponse.edit({
                        content: "LFG timed out! Please use /lfg again to create a new group.",
                        components: [],
                    });

                    interactionStatusTable.create({
                        interaction_id: interaction.id,
                        interaction_user: interaction.user.id,
                        interaction_status: "timeoutBeforeCreation",
                        command_used: "lfg",
                    });
                } else if (reason === "cancelled") {
                    await createStatusEmbed("LFG cancelled by the user.", dungeonResponse);

                    interactionStatusTable.create({
                        interaction_id: interaction.id,
                        interaction_user: interaction.user.id,
                        interaction_status: "cancelled",
                        command_used: "lfg",
                    });
                }
            });
        } catch (e) {
            processError(e, interaction);
        }
    },
};
