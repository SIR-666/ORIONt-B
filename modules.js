const sql = require("mssql");
const logger = require("./logger");

function parseTableFillingValues(
  date_start,
  line,
  machine,
  code,
  week,
  group,
  plant
) {
  let fillingMachine;

  if (typeof date_start === "string") {
    date_start = new Date(date_start);
  }

  let groupInitial;
  if (plant === "Yogurt") {
    const mapping = {
      "RANU REGULO": "R",
      "RANU PANI": "P",
      "RANU KUMBOLO": "K",
    };
    groupInitial = mapping[group] || group.charAt(0).toUpperCase();
  } else {
    groupInitial = group.charAt(0).toUpperCase(); // "K" from "KRAKATAU"
  }

  // Example parsing logic based on the input
  if (machine === "Planned Stop") {
    fillingMachine = "PNSTOP";
  } else if (machine === "Process Waiting") {
    fillingMachine = "WAIT";
  } else {
    fillingMachine = machine.toUpperCase();
  }

  const type = `${groupInitial}.${fillingMachine}.${code}`;

  let lineInitial;

  if (plant === "Milk Processing") {
    const mapping = {
      "FLEX 1": "A",
      "FLEX 2": "B",
      "GEA 3": "C",
      "GEA 4": "D",
      "GEA 5": "E",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Cheese") {
    const mapping = {
      "MOZ 200": "A",
      "MOZ 1000": "B",
      RICO: "C",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Yogurt") {
    const mapping = {
      YA: "A",
      YB: "B",
      YRTD: "YRa",
      PASTEURIZER: "S",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Milk Filling Packing") {
    const mapping = {
      "LINE A": "A",
      "LINE B": "B",
      "LINE C": "C",
      "LINE D": "D",
      "LINE E": "E",
      "LINE F": "F",
      "LINE G": "G",
      "LINE H": "H",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else {
    lineInitial = line.charAt(5).toUpperCase();
  }

  // Combine line name initials and date day for another column
  const dateDay = date_start.getDate().toString().padStart(2, "0"); // "28" from "2024-09-28"
  const dateMonth = date_start.getMonth() + 1;
  const dateYear = date_start.getFullYear();
  const No = `${lineInitial}DG${dateDay}`; // Result: "ADG28"
  const id = `${No}${week}${dateDay}${dateMonth}${dateYear}`;

  return { combined: No, typeDowntime: type, line: lineInitial, id: id };
}

function parseLine(line, date_start, week, plant) {
  let lineInitial;

  if (!line) {
    line = "UNKNOWN";
    logger.warn("parseLine | Line not provided, defaults to 'UNKNOWN'");
  } else {
    line = line.toUpperCase();
  }

  try {
    if (plant === "Milk Processing") {
      const mapping = {
        "FLEX 1": "A",
        "FLEX 2": "B",
        "GEA 3": "C",
        "GEA 4": "D",
        "GEA 5": "E",
      };
      lineInitial = mapping[line];
    } else if (plant === "Cheese") {
      const mapping = {
        "MOZ 200": "A",
        "MOZ 1000": "B",
        RICO: "C",
      };
      lineInitial = mapping[line];
    } else if (plant === "Yogurt") {
      const mapping = {
        YA: "A",
        YB: "B",
        YRTD: "YHa",
        PASTEURIZER: "S",
      };
      lineInitial = mapping[line];
    } else if (plant === "Milk Filling Packing") {
      const mapping = {
        "LINE A": "A",
        "LINE B": "B",
        "LINE C": "C",
        "LINE D": "D",
        "LINE E": "E",
        "LINE F": "F",
        "LINE G": "G",
        "LINE H": "H",
      };
      lineInitial = mapping[line];
    } else {
      lineInitial = line;
    }

    if (!lineInitial) {
      logger.error(
        `parseLine | Mapping failed for line: ${line} at plant: ${plant}`
      );
    }

    const dateDay = date_start.getDate().toString().padStart(2, "0");
    const dateMonth = date_start.getMonth() + 1;
    const dateYear = date_start.getFullYear();
    const No = `${lineInitial}EG${dateDay}`;
    const id = `${No}${week}${dateDay}${dateMonth}${dateYear}`;

    logger.info(
      `parseLine | line=${line}, plant=${plant}, lineInitial=${lineInitial}, id=${id}`
    );

    return { combined: No, id, line: lineInitial };
  } catch (err) {
    logger.error(`Error in parseLine: ${err.message}`);
    throw err;
  }
}

function parseLineInitial(plant, line) {
  let lineInitial;

  if (plant === "Milk Processing") {
    const mapping = {
      "Flex 1": "A",
      "Flex 2": "B",
      "GEA 3": "C",
      "GEA 4": "D",
      "GEA 5": "E",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Cheese") {
    const mapping = {
      "MOZ 200": "A",
      "MOZ 1000": "B",
      RICO: "C",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Yogurt") {
    const mapping = {
      YA: "A",
      YB: "B",
      YRTD: "YHa",
      PASTEURIZER: "S",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Milk Filling Packing") {
    const mapping = {
      "Line A": "A",
      "Line B": "B",
      "Line C": "C",
      "Line D": "D",
      "Line E": "E",
      "Line F": "F",
      "Line G": "G",
      "Line H": "H",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else {
    lineInitial = line.charAt(5).toUpperCase();
  }

  return lineInitial;
}

function parseLineSpeedLoss(line, date_start, plant) {
  let lineInitial;

  if (plant === "Milk Processing") {
    const mapping = {
      "Flex 1": "A",
      "Flex 2": "B",
      "GEA 3": "C",
      "GEA 4": "D",
      "GEA 5": "E",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Cheese") {
    const mapping = {
      "MOZ 200": "A",
      "MOZ 1000": "B",
      RICO: "C",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Yogurt") {
    const mapping = {
      YA: "A",
      YB: "B",
      YRTD: "YHa",
      PASTEURIZER: "S",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Milk Filling Packing") {
    const mapping = {
      "Line A": "A",
      "Line B": "B",
      "Line C": "C",
      "Line D": "D",
      "Line E": "E",
      "Line F": "F",
      "Line G": "G",
      "Line H": "H",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else {
    lineInitial = line.charAt(5).toUpperCase();
  }

  const localDate = new Date(date_start); // tetap UTC atau waktu asli
  const dateDay = localDate.getUTCDate().toString().padStart(2, "0");
  const No = `${lineInitial}EG${dateDay}`;
  console.log("No UTC", No);
  return { combined: No };
}

function parseLineWIB(line, date_start, plant) {
  let lineInitial;

  if (plant === "Milk Processing") {
    const mapping = {
      "Flex 1": "A",
      "Flex 2": "B",
      "GEA 3": "C",
      "GEA 4": "D",
      "GEA 5": "E",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Cheese") {
    const mapping = {
      "MOZ 200": "A",
      "MOZ 1000": "B",
      RICO: "C",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Yogurt") {
    const mapping = {
      YA: "A",
      YB: "B",
      YRTD: "YHa",
      PASTEURIZER: "S",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Milk Filling Packing") {
    const mapping = {
      "Line A": "A",
      "Line B": "B",
      "Line C": "C",
      "Line D": "D",
      "Line E": "E",
      "Line F": "F",
      "Line G": "G",
      "Line H": "H",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else {
    lineInitial = line.charAt(5).toUpperCase();
  }

  const localDate = new Date(date_start);
  localDate.setHours(localDate.getHours() + 7); // offset ke WIB
  const dateDay = localDate.getDate().toString().padStart(2, "0");
  const No = `${lineInitial}EG${dateDay}`; // Result: "ADG28"
  console.log("No WIB", No);
  return { combined: No };
}

function parseLineDowntime(line, date_start, week, plant) {
  let lineInitial;

  if (plant === "Milk Processing") {
    const mapping = {
      "Flex 1": "A",
      "Flex 2": "B",
      "GEA 3": "C",
      "GEA 4": "D",
      "GEA 5": "E",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Cheese") {
    const mapping = {
      "MOZ 200": "A",
      "MOZ 1000": "B",
      RICO: "C",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Yogurt") {
    const mapping = {
      YA: "A",
      YB: "B",
      YRTD: "YRa",
      PASTEURIZER: "S",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else if (plant === "Milk Filling Packing") {
    const mapping = {
      "Line A": "A",
      "Line B": "B",
      "Line C": "C",
      "Line D": "D",
      "Line E": "E",
      "Line F": "F",
      "Line G": "G",
      "Line H": "H",
    };
    lineInitial = mapping[line] || line.charAt(5).toUpperCase();
  } else {
    lineInitial = line.charAt(5).toUpperCase();
  }

  const dateDay = date_start.getDate().toString().padStart(2, "0");
  const dateMonth = date_start.getMonth() + 1;
  const dateYear = date_start.getFullYear();
  const No = `${lineInitial}DG${dateDay}`; // Result: "ADG28"
  const id = `${No}${week}${dateDay}${dateMonth}${dateYear}`;
  return { combined: No, id: id, line: lineInitial };
}

function getShift(shift, date) {
  let startTime = "";
  let endTime = "";
  let currentDate = new Date(date);

  switch (shift) {
    case "I":
      startTime = new Date(currentDate.setUTCHours(6, 0, 0, 0));
      endTime = new Date(currentDate.setUTCHours(14, 0, 0, 0));
      break;
    case "II":
      startTime = new Date(currentDate.setUTCHours(14, 0, 0, 0));
      endTime = new Date(currentDate.setUTCHours(22, 0, 0, 0));
      break;
    case "III":
      startTime = new Date(currentDate.setUTCHours(22, 0, 0, 0));
      endTime = new Date(currentDate.setUTCHours(6, 0, 0, 0));
      endTime.setUTCDate(endTime.getUTCDate() + 1);
      break;
    default:
      res.status(400).json({ error: "Invalid shift" });
      break;
  }

  return { start: startTime, end: endTime };
}

// const saveSplitOrders = async (
//   pool,
//   poNumber,
//   product_id,
//   qty,
//   startDate,
//   endDate,
//   startTime,
//   endTime,
//   plant,
//   line,
//   groupSelections
// ) => {
//   try {
//     const shifts = [
//       { start: "06:00", end: "14:00" }, // Shift I
//       { start: "14:00", end: "22:00" }, // Shift II
//       { start: "22:00", end: "06:00" }, // Shift III (next day)
//     ];

//     const start = new Date(startTime);
//     const end = new Date(endTime);

//     let currentShiftEnd = null;

//     const allShifts = [
//       ...shifts,
//       ...shifts.map((shift) => ({ ...shift, isPreviousDay: true })),
//     ];

//     for (const shift of allShifts) {
//       const shiftStart = new Date(start);
//       const shiftEnd = new Date(start);

//       const [startHour, startMinute] = shift.start.split(":").map(Number);
//       const [endHour, endMinute] = shift.end.split(":").map(Number);

//       if (shift.isPreviousDay) {
//         shiftStart.setDate(shiftStart.getDate() - 1); // Move to previous day
//         shiftEnd.setDate(shiftEnd.getDate() - 1);
//       }

//       shiftStart.setHours(startHour, startMinute, 0, 0);
//       if (
//         endHour < startHour ||
//         (endHour === startHour && endMinute < startMinute)
//       ) {
//         // Handles shifts ending the next day
//         shiftEnd.setDate(shiftEnd.getDate() + 1);
//       }
//       shiftEnd.setHours(endHour, endMinute, 0, 0);

//       // Check if the start time falls within this shift
//       if (start >= shiftStart && start < shiftEnd) {
//         currentShiftEnd = shiftEnd;
//         break;
//       }
//     }

//     if (currentShiftEnd) {
//       await pool
//         .request()
//         .input("poNumber", sql.BigInt, poNumber)
//         .input("shiftEnd", sql.DateTime, currentShiftEnd).query(`
//           UPDATE [dbo].[ProductionOrder]
//           SET [actual_end] = @shiftEnd,
//               [status] = 'Completed',
//               [updated_at] = GETDATE()
//           WHERE id = @poNumber
//         `);

//       // Adjust the start time for the split orders
//       startTime = currentShiftEnd;
//     }

//     const splitOrders = [];
//     let current = new Date(start);

//     let groupId;
//     let groupIndex = 0; // Initialize the group index
//     while (current < end) {
//       for (let i = 0; i < shifts.length; i++) {
//         const shift = shifts[i];
//         const shiftStart = new Date(current);
//         const shiftEnd = new Date(current);

//         const [startHour, startMinute] = shift.start.split(":").map(Number);
//         const [endHour, endMinute] = shift.end.split(":").map(Number);

//         shiftStart.setHours(startHour, startMinute, 0, 0);
//         if (endHour < startHour) {
//           // Handles shifts ending the next day
//           shiftEnd.setDate(shiftEnd.getDate() + 1);
//         }
//         shiftEnd.setHours(endHour, endMinute, 0, 0);

//         const groupSelection = groupSelections[groupIndex]; // Use groupIndex instead of i
//         if (!groupSelection) {
//           console.warn(`No group selection for group index ${groupIndex}`);
//           groupIndex = 0; // Reset to the first group if out of bounds
//           continue;
//         }

//         switch (groupSelection) {
//           case "BROMO":
//             groupId = 1;
//             break;

//           case "SEMERU":
//             groupId = 2;
//             break;

//           case "KRAKATAU":
//             groupId = 3;
//             break;

//           default:
//             console.error(`Unknown group selection: ${groupSelection}`);
//             groupId = null;
//             break;
//         }

//         if (start < shiftEnd && end > shiftStart && start < shiftStart) {
//           const actualStart = start > shiftStart ? start : shiftStart;
//           const actualEnd = end < shiftEnd ? end : shiftEnd;

//           // Push split order to array
//           splitOrders.push({
//             poNumber,
//             actual_start: actualStart,
//             actual_end: actualEnd,
//             group: groupId,
//           });

//           groupIndex = (groupIndex + 1) % Object.keys(groupSelections).length;
//         }

//         // Update the `current` pointer
//         current = new Date(shiftEnd);
//       }
//     }

//     // Save all split orders to the database
//     for (const order of splitOrders) {
//       await pool
//         .request()
//         .input("poNumber", sql.VarChar, order.poNumber)
//         .input("productId", sql.Int, product_id)
//         .input("qty", sql.Int, qty)
//         .input("date_start", sql.DateTime, startDate)
//         .input("date_end", sql.DateTime, endDate)
//         .input("actual_start", sql.DateTime, order.actual_start)
//         .input("actual_end", sql.DateTime, order.actual_end)
//         .input("plant", sql.VarChar, plant)
//         .input("line", sql.VarChar, line)
//         .input("group", sql.Int, order.group).query(`
//           INSERT INTO ProductionOrder (id, product_id, qty, [date_start], [date_end], [status], [created_at], [updated_at], [actual_start], [actual_end], [plant], [line], [completion_count], [group])
//           VALUES (@poNumber, @productId, @qty, @date_start, @date_end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 0, @group)
//         `);
//     }

//     console.log("Split orders saved successfully!");
//     return splitOrders; // Return split orders for debugging or other uses
//   } catch (error) {
//     console.error("Error saving split orders:", error);
//     throw error;
//   }
// };

const saveSplitOrders = async (
  pool,
  poNumber,
  product_id,
  qty,
  startDate,
  endDate,
  startTime,
  endTime,
  plant,
  line,
  groupSelections
) => {
  try {
    if (
      !groupSelections ||
      !Array.isArray(groupSelections) ||
      groupSelections.length === 0
    ) {
      throw new Error("Invalid or empty groupSelections provided.");
    }

    const shifts = [
      { start: "06:00", end: "14:00" },
      { start: "14:00", end: "22:00" },
      { start: "22:00", end: "06:00" },
    ];

    const start = new Date(startTime);
    const end = new Date(endTime);
    let currentShiftEnd = null;

    const allShifts = [
      ...shifts,
      ...shifts.map((shift) => ({ ...shift, isPreviousDay: true })),
    ];

    for (const shift of allShifts) {
      const shiftStart = new Date(start);
      const shiftEnd = new Date(start);

      const [startHour, startMinute] = shift.start.split(":").map(Number);
      const [endHour, endMinute] = shift.end.split(":").map(Number);

      if (shift.isPreviousDay) {
        shiftStart.setDate(shiftStart.getDate() - 1);
        shiftEnd.setDate(shiftEnd.getDate() - 1);
      }

      shiftStart.setHours(startHour, startMinute, 0, 0);
      if (
        endHour < startHour ||
        (endHour === startHour && endMinute < startMinute)
      ) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }
      shiftEnd.setHours(endHour, endMinute, 0, 0);

      if (start >= shiftStart && start < shiftEnd) {
        currentShiftEnd = shiftEnd;
        console.warn(`start melebihi batas : ${plant}`);
        console.warn(`start melebihi batas : ${product_id}`);
        break;
      }
    }

    if (currentShiftEnd) {
      await pool
        .request()
        .input("poNumber", sql.BigInt, poNumber)
        .input("shiftEnd", sql.DateTime, currentShiftEnd).query(`
          UPDATE [dbo].[ProductionOrder]
          SET [actual_end] = @shiftEnd, 
              [status] = 'Completed', 
              [updated_at] = GETDATE()
          WHERE id = @poNumber
        `);

      startTime = currentShiftEnd;
    }

    const splitOrders = [];
    let current = new Date(startTime);
    let groupIndex = 0;

    while (current < end) {
      for (let i = 0; i < shifts.length && current < end; i++) {
        const shift = shifts[i];
        const shiftStart = new Date(current);
        const shiftEnd = new Date(current);

        const [startHour, startMinute] = shift.start.split(":").map(Number);
        const [endHour, endMinute] = shift.end.split(":").map(Number);

        shiftStart.setHours(startHour, startMinute, 0, 0);
        if (endHour < startHour) shiftEnd.setDate(shiftEnd.getDate() + 1);
        shiftEnd.setHours(endHour, endMinute, 0, 0);

        const groupSelection = groupSelections[groupIndex];
        let groupId;

        switch (groupSelection) {
          case "BROMO":
            groupId = 1;
            break;
          case "SEMERU":
            groupId = 2;
            break;
          case "KRAKATAU":
            groupId = 3;
            break;
          default:
            console.warn(`Unknown group selection: ${groupSelection}`);
            current = new Date(shiftEnd); // Tetap majukan waktu!
            groupIndex = (groupIndex + 1) % groupSelections.length;
            continue; // Skip iterasi ini
        }

        if (current < shiftEnd && end > shiftStart) {
          const actualStart = current > shiftStart ? current : shiftStart;
          const actualEnd = end < shiftEnd ? end : shiftEnd;

          splitOrders.push({
            poNumber,
            actual_start: actualStart,
            actual_end: actualEnd,
            group: groupId,
          });

          groupIndex = (groupIndex + 1) % groupSelections.length;
        }

        current = new Date(shiftEnd); // Selalu majukan waktu
      }
    }

    for (const order of splitOrders) {
      await pool
        .request()
        .input("poNumber", sql.VarChar, order.poNumber)
        .input("productId", sql.Int, product_id)
        .input("qty", sql.Int, qty)
        .input("date_start", sql.DateTime, startDate)
        .input("date_end", sql.DateTime, endDate)
        .input("actual_start", sql.DateTime, order.actual_start)
        .input("actual_end", sql.DateTime, order.actual_end)
        .input("plant", sql.VarChar, plant)
        .input("line", sql.VarChar, line)
        .input("group", sql.Int, order.group).query(`
          INSERT INTO ProductionOrder (
            id, product_id, qty, date_start, date_end, status,
            created_at, updated_at, actual_start, actual_end,
            plant, line, completion_count, [group]
          ) VALUES (
            @poNumber, @productId, @qty, @date_start, @date_end, 'Completed',
            GETDATE(), GETDATE(), @actual_start, @actual_end,
            @plant, @line, 0, @group
          )
        `);
    }

    console.log("Split orders saved successfully!");
    return splitOrders;
  } catch (error) {
    console.error("Error saving split orders:", error);
    throw error;
  }
};

const getShiftEndTime = async (pool, date) => {
  const dateObj = new Date(date); // Parsed local time in UTC format
  const hours = dateObj.getUTCHours(); // Get hours directly in UTC to check shift time

  let endTime = new Date(dateObj); // Start with the same date/time in UTC

  let startTime = new Date(dateObj);
  // Set end time based on shift hours
  if (hours >= 6 && hours < 14) {
    startTime.setUTCHours(6, 0, 0, 0);
    endTime.setUTCHours(14, 0, 0, 0); // Shift 1 ends at 14:00
  } else if (hours >= 14 && hours < 22) {
    startTime.setUTCHours(14, 0, 0, 0);
    endTime.setUTCHours(22, 0, 0, 0); // Shift 2 ends at 22:00
  } else {
    if (hours >= 22) {
      startTime.setUTCHours(22, 0, 0, 0);
      endTime.setUTCDate(dateObj.getUTCDate() + 1);
      endTime.setUTCHours(6, 0, 0, 0);
    } else {
      startTime.setDate(dateObj.getUTCDate() - 1);
      startTime.setUTCHours(22, 0, 0, 0);
      endTime.setUTCHours(6, 0, 0, 0);
    }
  }

  const shiftQuery = `
    SELECT actual_start FROM ProductionOrder WHERE actual_start >= @start AND actual_end <= @end;
    `;
  try {
    const shiftResult = await pool
      .request()
      .input("start", sql.DateTime, startTime)
      .input("end", sql.DateTime, endTime)
      .query(shiftQuery);

    if (shiftResult.recordset.length > 0) {
      // Find the earliest production order that starts after dateObj and before endTime
      let earliestAfterCurrentTime = null;

      for (const record of shiftResult.recordset) {
        const dbStartTime = new Date(record.actual_start);

        // Check if this start time is after dateObj and before the current endTime
        if (dbStartTime > dateObj && dbStartTime < endTime) {
          if (
            earliestAfterCurrentTime === null ||
            dbStartTime < earliestAfterCurrentTime
          ) {
            earliestAfterCurrentTime = dbStartTime;
          }
        }
      }

      // Update endTime if we found a relevant production order start time
      if (earliestAfterCurrentTime !== null) {
        endTime = earliestAfterCurrentTime;
        console.log(
          "Updated endTime to the start of the next production order:",
          endTime
        );
      }
    }

    return endTime; // Return endTime as default
  } catch (err) {
    console.error("Error executing shift query:", err.message);
    throw err; // Re-throw error to handle upstream
  }
};

const formatDateTime = (date, time) => {
  const formattedDate = date.split(".").reverse().join("-");
  return new Date(`${formattedDate} ${time}`);
};

// Helper function to fetch product ID or insert a new product
const getOrCreateProduct = async (pool, material) => {
  const productQuery = `
    SELECT id FROM Product WHERE sku = @sku
  `;
  const productResult = await pool
    .request()
    .input("sku", sql.VarChar, material)
    .query(productQuery);

  if (productResult.recordset.length > 0) {
    return productResult.recordset[0].id;
  }

  const insertProductQuery = `
    DECLARE @newId INT;
    SET @newId = (SELECT COALESCE(MAX(id), 0) + 1 FROM Product);
    INSERT INTO Product (id, sku, category, volume, created_at, updated_at, flag)
    VALUES (
      @newId,
      @sku,
      CASE 
          WHEN @sku LIKE '%UHT%' THEN 'UHT'
          WHEN @sku LIKE '%ESL%' THEN 'ESL'
          ELSE 'Unknown'
      END,
      COALESCE(
        TRY_CAST(
          SUBSTRING(@sku, PATINDEX('%[0-9]%', @sku), 
            CASE 
              WHEN PATINDEX('%[^0-9]%', SUBSTRING(@sku, PATINDEX('%[0-9]%', @sku), LEN(@sku))) = 0 
              THEN LEN(@sku) - PATINDEX('%[0-9]%', @sku)
              ELSE PATINDEX('%[^0-9]%', SUBSTRING(@sku, PATINDEX('%[0-9]%', @sku), LEN(@sku))) 
            END
          ) AS INT
        ), 0
      ),
      GETDATE(), GETDATE(), 1
    );
    SELECT @newId AS id;
  `;
  const insertResult = await pool
    .request()
    .input("sku", sql.VarChar, material)
    .query(insertProductQuery);

  if (insertResult.recordset.length > 0) {
    // Return the newly created product ID
    return insertResult.recordset[0].id;
  }

  throw new Error("Failed to insert new product.");
};

function getTableName(plant, line) {
  const tableMapping = {
    "Milk Processing": "tb_processing_downtime_all2",
    "Milk Filling Packing": "tb_filling_downtime_all2",
    Cheese: "tb_packingCheese_downtime_all",
  };

  if (plant === "Yogurt") {
    const upperLine = line?.toUpperCase() || "";

    if (["YA", "YB", "YD (POUCH)"].includes(upperLine)) {
      return "tb_yogurt_downtime_all";
    } else if (upperLine === "YRTD") {
      return "tb_rtd_downtime_all";
    } else if (upperLine === "PASTEURIZER") {
      return "tb_processingYGT_downtime_all2";
    }

    // Default fallback jika line tidak cocok
    return "tb_yogurt_downtime_all";
  }

  // Untuk plant lain
  return tableMapping[plant] || null;
}

//table performance report
function getTablePerformName(plant, line) {
  const tableMapping = {
    "Milk Processing": "PBI_plant_oee_daily_pro_2224",
    "Milk Filling Packing": "PBI_plant_oee_daily_f_2224",
    Cheese: "PBI_plant_oee_daily_chs_2224",
  };

  if (plant === "Yogurt") {
    const upperLine = line?.toUpperCase() || "";

    if (["YA", "YB", "YD (POUCH)"].includes(upperLine)) {
      return "PBI_plant_oee_daily_y_2224";
    } else if (upperLine === "YRTD") {
      return "PBI_plant_oee_daily_y_2224";
    } else if (upperLine === "PASTEURIZER") {
      return "PBI_plant_oee_daily_pasteur_ygt_2224";
    }

    // Default fallback jika line tidak cocok
    return "PBI_plant_oee_daily_y_2224";
  }

  // Untuk plant lain
  return tableMapping[plant] || null;
}

function getViewFinishGoodLiter(plant, line) {
  const tableMapping = {
    "Milk Processing": "VW_Processing_FinishGoodLiter",
    "Milk Filling Packing": "VW_Filling_FinishGoodLiter",
    Cheese: "VW_Cheese_FinishGoodLiter",
  };

  if (plant === "Yogurt") {
    const upperLine = line?.toUpperCase() || "";

    if (["YA", "YB", "YD (POUCH)"].includes(upperLine)) {
      return "VW_Yogurt_FinishGoodLiter";
    } else if (upperLine === "YRTD") {
      return "VW_Yogurt_FinishGoodLiter";
    } else if (upperLine === "PASTEURIZER") {
      return "VW_Pasteurizer_FinishGoodLiter";
    }

    // Default fallback jika line tidak cocok
    return "VW_Yogurt_FinishGoodLiter";
  }

  // Untuk plant lain
  return tableMapping[plant] || null;
}

function getProductionName(plant, line) {
  const tableMapping = {
    "Milk Processing": "HASIL PRODUKSI (AFT LOSS)",
    "Milk Filling Packing": "Finish Good (Pcs)",
    Cheese: "Finish Good (Pcs)",
  };

  if (plant === "Yogurt") {
    const upperLine = line?.toUpperCase() || "";

    if (["YA", "YB", "YRTD"].includes(upperLine)) {
      return "Finish Good (Pcs)";
    } else if (upperLine === "PASTEURIZER") {
      return "HASIL PRODUKSI (AFT LOSS)";
    }

    // Default fallback jika line tidak cocok
    return "Finish Good (Pcs)";
  }

  return tableMapping[plant];
}

module.exports = {
  parseTableFillingValues,
  parseLine,
  parseLineInitial,
  parseLineDowntime,
  parseLineSpeedLoss,
  parseLineWIB,
  saveSplitOrders,
  getShift,
  getShiftEndTime,
  formatDateTime,
  getOrCreateProduct,
  getTableName,
  getTablePerformName,
  getViewFinishGoodLiter,
  getProductionName,
};
