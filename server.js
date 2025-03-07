require("dotenv").config();
const express = require("express");
const sql = require("mssql");
const config = require("./config");

const app = express();
const port = process.env.PORT_1 | 3001;
app.use(express.json());

// API Route to get master data for Plant and Line
app.get("/api/getPlantLine", async (req, res) => {
  try {
    const apiUrl = "http://10.24.7.70:8080/getgreenTAGarea";
    if (!apiUrl) {
      console.error("URL_FETCH environment variable is not set.");
      return res.status(500).send("Server configuration error");
    }
    const response = await fetch(apiUrl);

    // Optionally process or modify the data here before sending it to clients
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const selectedData = data
      .filter((item) => item.observedArea)
      .map((item) => ({
        id: item.id,
        plant: item.observedArea,
        line:
          item.observedArea === "Milk Processing" ? item.subGroup : item.line,
      }));

    const uniqueProcessingItems = Array.from(
      new Map(
        selectedData
          .filter((item) => item.plant === "Milk Processing")
          .map((item) => [item.line, item])
      ).values()
    );

    const uniqueFillingItems = Array.from(
      new Map(
        selectedData
          .filter((item) => item.plant === "Milk Filling Packing")
          .map((item) => [item.line, item])
      ).values()
    );

    const finalData = uniqueProcessingItems.concat(uniqueFillingItems);
    res.json(finalData);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching data");
  }
});

const { formatDateTime, getOrCreateProduct } = require("./modules");

// insert PO from SAP to local database
app.post("/createPO", async (req, res) => {
  const { id, date, line, group } = req.body;

  try {
    const pool = await sql.connect(config);
    const groupResult = await pool
      .request()
      .input("group", sql.VarChar, group)
      .query("SELECT id FROM GroupMaster WHERE [group] = @group;");

    const groupId = groupResult.recordset[0]?.id;

    const time = new Date(date);
    const year = time.getFullYear();
    const month = time.getMonth() + 1;

    const apiResponse = await fetch(
      `http://10.24.7.70:8080/getProcessOrderSAP/${year}/${month}/GF%20MILK`
    );
    const allData = await apiResponse.json();
    const record = allData.find((item) => item["NO PROCESS ORDER"] === id);

    if (!record) {
      return res
        .status(404)
        .json({ message: `Record with NO PROCESS ORDER ${id} not found.` });
    }

    const {
      "NO PROCESS ORDER": noProcessOrder,
      MATERIAL: material,
      "TANGGAL SCHEDULED START": startDate,
      "TIME SCHEDULED START": startTime,
      "TANGGAL SCHEDULED END": endDate,
      "TIME SCHEDULED END": endTime,
      "TOTAL QUANTITY / GR": qty,
    } = record;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "Invalid date format or missing date." });
    }

    const localDateTimeStart = formatDateTime(startDate, startTime);
    const localDateTimeEnd = formatDateTime(endDate, endTime);

    const cleanedQty = qty.replace(/,/g, "");
    const qtyFloat = isNaN(parseFloat(cleanedQty)) ? 0 : parseFloat(cleanedQty);
    // const qtyInt = isNaN(parseInt(cleanedQty)) ? 0 : parseInt(cleanedQty);
    let finalQtyInt;

    if (qty.includes(",") || qty.includes(".")) {
      // If the number has a comma or decimal, multiply by 1000 if the decimal is present
      finalQtyInt = cleanedQty.includes(".")
        ? parseFloat(cleanedQty) * 1000
        : parseInt(cleanedQty);
    } else {
      finalQtyInt = parseInt(cleanedQty);
    }
    console.log("Float value: ", qtyFloat);
    console.log("Final value: ", finalQtyInt);

    const productId = await getOrCreateProduct(pool, material);

    console.log("Retrieved Product id: ", productId);

    const existingOrderQuery = `
      SELECT id FROM ProductionOrder WHERE id = @po
    `;
    const existingOrder = await pool
      .request()
      .input("po", sql.BigInt, parseInt(noProcessOrder, 10))
      .query(existingOrderQuery);

    if (existingOrder.recordset.length > 0) {
      return res
        .status(400)
        .json({ message: "Production Order already exists in another line." });
    }

    const insertOrderQuery = `
      INSERT INTO [dbo].[ProductionOrder] 
      (
        id, product_id, qty, date_start, date_end, status, created_at, updated_at, actual_start, actual_end, plant, line, completion_count, [group]
      )
      VALUES (
        @id, @product, @qty, @start, @end, 'Active', GETDATE(), GETDATE(), @actual, NULL, 'Milk Filling Packing', @line, 0, @group
      )
    `;
    const orderResult = await pool
      .request()
      .input("id", sql.BigInt, parseInt(noProcessOrder, 10))
      .input("product", sql.Int, productId)
      .input("qty", sql.Int, finalQtyInt)
      .input("start", sql.DateTime, localDateTimeStart)
      .input("end", sql.DateTime, localDateTimeEnd)
      .input("actual", sql.DateTime, date)
      .input("line", sql.VarChar, line.toUpperCase())
      .input("group", sql.Int, groupId)
      .query(insertOrderQuery);

    if (orderResult.rowsAffected[0] === 0) {
      throw new Error("Failed to insert production order.");
    }

    return res.json({
      rowsAffected: orderResult.rowsAffected,
      message: "Successfully inserted PO from SAP to local database",
    });
  } catch (error) {
    console.error("Error occurred:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Create empty PO with No PO as the product for UT-No PO insertion
app.post("/createEmptyPO", async (req, res) => {
  const { date_start, date_end, plant, line, groupSelection } = req.body;

  try {
    let pool = await sql.connect(config);

    let baseId = 666666000000;
    let idExists = true;

    while (idExists) {
      const idCheckResult = await pool
        .request()
        .input("id", sql.BigInt, baseId)
        .query("SELECT 1 FROM [dbo].[ProductionOrder] WHERE id = @id;");

      if (idCheckResult.recordset.length === 0) {
        idExists = false; // Unique ID found
      } else {
        baseId++; // Increment ID
      }
    }

    let insertOrderQuery;
    if (groupSelection && Object.keys(groupSelection).length > 1) {
      const shifts = [
        { start: "06:00", end: "14:00" }, // Shift I
        { start: "14:00", end: "22:00" }, // Shift II
        { start: "22:00", end: "06:00" }, // Shift III (next day)
      ];

      const allShifts = [
        ...shifts,
        ...shifts.map((shift) => ({ ...shift, isPreviousDay: true })),
      ];

      const start = new Date(date_start);
      const end = new Date(date_end);

      let currentShiftEnd = null;

      for (const shift of allShifts) {
        const shiftStart = new Date(start);
        const shiftEnd = new Date(start);

        const [startHour, startMinute] = shift.start.split(":").map(Number);
        const [endHour, endMinute] = shift.end.split(":").map(Number);

        if (shift.isPreviousDay) {
          shiftStart.setDate(shiftStart.getDate() - 1); // Move to previous day
          shiftEnd.setDate(shiftEnd.getDate() - 1);
        }

        shiftStart.setHours(startHour, startMinute, 0, 0);
        if (
          endHour < startHour ||
          (endHour === startHour && endMinute < startMinute)
        ) {
          // Handles shifts ending the next day
          shiftEnd.setDate(shiftEnd.getDate() + 1);
        }
        shiftEnd.setHours(endHour, endMinute, 0, 0);

        console.log("Shift start: ", shiftStart);
        console.log("Shift end: ", shiftEnd);

        // Check if the start time falls within this shift
        if (start >= shiftStart && start < shiftEnd) {
          currentShiftEnd = shiftEnd;
          break;
        }
      }

      console.log("Current shift end: ", currentShiftEnd);

      console.log("Start PO: ", start);
      console.log("End PO: ", end);

      const splitOrders = [];
      let current = new Date(start);

      console.log("Current: ", current);

      let groupId;
      let groupIndex = 1;

      const firstGroup = groupSelection[0];
      const groupResult = await pool
        .request()
        .input("group", sql.VarChar, firstGroup)
        .query("SELECT id FROM GroupMaster WHERE [group] = @group;");

      const groupNumber = groupResult.recordset[0]?.id;

      if (!groupNumber) {
        return res.status(400).json({ message: "Invalid group provided." });
      }

      if (currentShiftEnd) {
        await pool
          .request()
          .input("id", sql.BigInt, baseId)
          .input("start", sql.DateTime, date_start)
          .input("end", sql.DateTime, date_end)
          .input("actual_start", sql.DateTime, date_start)
          .input("actual_end", sql.DateTime, currentShiftEnd)
          .input("plant", sql.VarChar, plant)
          .input("line", sql.VarChar, line.toUpperCase())
          .input("group", sql.Int, groupNumber).query(`
          INSERT INTO [dbo].[ProductionOrder] 
        (
          id, product_id, qty, date_start, date_end, status, created_at, updated_at, actual_start, actual_end, plant, line, completion_count, [group]
        )
        VALUES (
          @id, 100, 0, @start, @end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 1, @group
        )
        `);
      }

      while (current < end) {
        for (let i = 0; i < shifts.length; i++) {
          const shift = shifts[i];
          const shiftStart = new Date(current);
          const shiftEnd = new Date(current);

          const [startHour, startMinute] = shift.start.split(":").map(Number);
          const [endHour, endMinute] = shift.end.split(":").map(Number);

          shiftStart.setHours(startHour, startMinute, 0, 0);
          if (endHour < startHour) {
            // Handles shifts ending the next day
            shiftEnd.setDate(shiftEnd.getDate() + 1);
          }
          shiftEnd.setHours(endHour, endMinute, 0, 0);

          // console.log("Shift start time: ", shiftStart);
          // console.log("Shift end time: ", shiftEnd);

          const groupSelections = groupSelection[groupIndex]; // Use groupIndex instead of i
          if (!groupSelections) {
            console.warn(`No group selection for group index ${groupIndex}`);
            groupIndex = 0; // Reset to the first group if out of bounds
            continue;
          }
          console.log("Groups: ", groupSelections);

          switch (groupSelections) {
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
              console.error(`Unknown group selection: ${groupSelections}`);
              groupId = null;
              break;
          }

          if (start < shiftEnd && end > shiftStart && start < shiftStart) {
            const actualStart = start > shiftStart ? start : shiftStart;
            const actualEnd = end < shiftEnd ? end : shiftEnd;

            // Push split order to array
            splitOrders.push({
              baseId,
              actual_start: actualStart,
              actual_end: actualEnd,
              group: groupId,
            });

            groupIndex = (groupIndex + 1) % Object.keys(groupSelection).length;
          }

          // Update the `current` pointer
          current = new Date(shiftEnd);
        }
      }

      for (const order of splitOrders) {
        insertOrderQuery = await pool
          .request()
          .input("id", sql.BigInt, baseId)
          .input("start", sql.DateTime, date_start)
          .input("end", sql.DateTime, date_end)
          .input("actual_start", sql.DateTime, order.actual_start)
          .input("actual_end", sql.DateTime, order.actual_end)
          .input("plant", sql.VarChar, plant)
          .input("line", sql.VarChar, line.toUpperCase())
          .input("group", sql.Int, order.group)
          .query(`INSERT INTO [dbo].[ProductionOrder] 
        (
          id, product_id, qty, date_start, date_end, status, created_at, updated_at, actual_start, actual_end, plant, line, completion_count, [group]
        )
        VALUES (
          @id, 100, 0, @start, @end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 1, @group
        )`);
      }
    } else {
      const groupResult = await pool
        .request()
        .input("group", sql.VarChar, groupSelection[0])
        .query("SELECT id FROM GroupMaster WHERE [group] = @group;");

      const groupId = groupResult.recordset[0]?.id;

      if (!groupId) {
        return res.status(400).json({ message: "Invalid group provided." });
      }

      const insertQuery = `
      INSERT INTO [dbo].[ProductionOrder] 
      (
        id, product_id, qty, date_start, date_end, status, created_at, updated_at, actual_start, actual_end, plant, line, completion_count, [group]
      )
      VALUES (
        @id, 100, 0, @start, @end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 1, @group
      )
    `;
      insertOrderQuery = await pool
        .request()
        .input("id", sql.BigInt, baseId)
        .input("start", sql.DateTime, date_start)
        .input("end", sql.DateTime, date_end)
        .input("actual_start", sql.DateTime, date_start)
        .input("actual_end", sql.DateTime, date_end)
        .input("plant", sql.VarChar, plant)
        .input("line", sql.VarChar, line.toUpperCase())
        .input("group", sql.Int, groupId)
        .query(insertQuery);
    }

    if (insertOrderQuery.rowsAffected[0] === 0) {
      throw new Error("Failed to insert production order.");
    }

    return res.json({
      rowsAffected: insertOrderQuery.rowsAffected,
      message: "Successfully created PO for UT-No PO insertion",
      id: baseId,
    });
  } catch (error) {
    console.error("Error occurred:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

app.get("/getAllGroup/:plant", async (req, res) => {
  const { plant } = req.params;

  try {
    let pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("plant", sql.VarChar, plant)
      .query("SELECT [group] FROM GroupMaster WHERE plant = @plant;");

    console.log("Retrieved group data: ", result.recordset);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const { getShift } = require("./modules");

// API route to get all production orders (tambah parameter)
app.get("/getAllPO/:line/:shift/:date", async (req, res) => {
  const { line, shift, date } = req.params;
  try {
    // Connect to the database
    let pool = await sql.connect(config);

    const getStartEndTime = getShift(shift, date);

    // Run the query
    const result = await pool
      .request()
      .input("line", sql.VarChar, line)
      .input("start", sql.DateTime, getStartEndTime.start)
      .input("end", sql.DateTime, getStartEndTime.end)
      .query(`SELECT PO.id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.plant, PO.line 
        FROM ProductionOrder PO 
        INNER JOIN Product P 
        ON PO.product_id = P.id 
        WHERE 
        PO.line = @line
        AND (
          (PO.actual_start >= @start AND PO.actual_start < @end AND PO.actual_end IS NULL)
          OR 
          (PO.actual_start < @end AND (PO.actual_end > @start OR PO.actual_end IS NULL))
        )
        ORDER BY 
          PO.status DESC`);

    console.log("Retrieved Production Order:", result.recordset);
    // Send the result back to the client
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getAllPOLine/:line", async (req, res) => {
  const { line } = req.params;

  try {
    let pool = await sql.connect(config);

    const result = await pool
      .request()
      .input("line", sql.VarChar, line)
      .query(
        `SELECT id, status, actual_start, actual_end FROM ProductionOrder WHERE line = @line;`
      );

    console.log("Retrieved Production Order:", result.recordset);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getOrders", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const result = await pool
      .request()
      .query(`SELECT id FROM ProductionOrder;`);

    console.log(result);
    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/getAllPOShift", async (req, res) => {
  const { line, date_start, date_end } = req.body;

  try {
    // Connect to the database
    let pool = await sql.connect(config);

    // Run the query
    const result = await pool
      .request()
      .input("line", sql.VarChar, line)
      .input("start", sql.DateTime, date_start)
      .input("end", sql.DateTime, date_end)
      .query(`SELECT PO.id, PO.product_id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.plant, PO.line
      FROM ProductionOrder PO
      INNER JOIN Product P
        ON PO.product_id = P.id
        AND PO.line = @line
        AND (
          (PO.actual_start >= @start AND PO.actual_start < @end)
          OR
          (PO.actual_end <= @end AND PO.actual_end > @start)
          OR
          (PO.actual_start < @start AND PO.actual_end > @end)
           OR
          (PO.actual_start < @end AND PO.actual_end IS NULL)
        ) 
         order by actual_start;`);

    console.log("Retrieved Production Order:", result.recordset);
    if (result.recordset.length === 0) {
      res.status(404).json({
        message: "No production orders found for the specified shift and line.",
      });
    } else {
      res.status(200).json(result.recordset);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// API route to get specific production order
app.get("/getPO/:id", async (req, res) => {
  const { id } = req.params;

  try {
    let pool = await sql.connect(config);
    const result = await pool.request().input("id", sql.VarChar, id)
      .query(`SELECT PO.id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.line, G.[group] 
          FROM ProductionOrder PO 
          INNER JOIN Product P 
          ON PO.product_id = P.id 
          LEFT JOIN GroupMaster G
          ON PO.[group] = G.id
          WHERE PO.id = @id;`);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
  }
});

app.post("/getSpeedSKU", async (req, res) => {
  const { sku } = req.body;

  try {
    let pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("sku", sql.VarChar, sku)
      .query(`SELECT speed FROM Product where sku = @sku;`);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
  }
});

// API Route to get Employee Data (WIP)

const { getShiftEndTime } = require("./modules");

// API Route to update PO start time and end time
app.post("/updateStartEndPO", async (req, res) => {
  const { id, date, actual_start, actual_end, poStart, poEnd } = req.body;
  console.log(
    "Received data from front-end: ",
    id,
    date,
    actual_start,
    actual_end,
    poStart,
    poEnd
  );

  let pool;
  try {
    pool = await sql.connect(config);

    let setClause = [];
    if (actual_start) setClause.push("[actual_start] = @actualStart");
    if (actual_end) setClause.push("[actual_end] = @actualEnd");
    setClause.push("[updated_at] = GETDATE()"); // Always include updated_at

    const query = `
        UPDATE [dbo].[ProductionOrder]
        SET ${setClause.join(", ")} 
        WHERE id = @id
        AND actual_start = @poStart
        AND actual_end = @poEnd
    `;

    const request = pool
      .request()
      .input("id", sql.BigInt, id)
      .input("poStart", sql.DateTime, poStart)
      .input("poEnd", sql.DateTime, poEnd);

    if (actual_start) request.input("actualStart", sql.DateTime, actual_start);
    if (actual_end) request.input("actualEnd", sql.DateTime, actual_end);

    const result = await request.query(query);
    console.log("Rows affected:", result.rowsAffected);
    res.status(200).json({ success: true, rowsAffected: result.rowsAffected });
  } catch (error) {
    console.error("Error updating timestamps:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating timestamps", error });
  } finally {
    if (pool) await pool.close();
  }
});

const { saveSplitOrders } = require("./modules");

// API Route to Start and Stop Production Order
app.post("/updatePO", async (req, res) => {
  const { id, date, group, groupSelection } = req.body;

  try {
    let pool = await sql.connect(config);
    const groupResult = await pool
      .request()
      .input("group", sql.VarChar, group)
      .query("SELECT id FROM GroupMaster WHERE [group] = @group;");

    const groupId = groupResult.recordset[0]?.id;

    const statusResult = await pool
      .request()
      .input("id", sql.BigInt, id)
      .query(
        `SELECT status, date_start, date_end, completion_count, product_id, actual_start, line, qty, plant FROM [dbo].[ProductionOrder] WHERE id = @id`
      );

    const {
      status: currentStatus,
      completion_count: completion_count,
      date_start: dateStart,
      date_end: dateEnd,
      product_id: currentProduct,
      actual_start: currentStart,
      line: currentLine,
      qty: currentQty,
      plant: currentPlant,
    } = statusResult.recordset[0] || {};

    const endTime = await getShiftEndTime(pool, date);

    if (currentStatus === "New") {
      const result = await pool
        .request()
        .input("id", sql.Int, id)
        .input("date_start", sql.DateTime, date)
        .input("group", sql.Int, groupId).query(`UPDATE [dbo].[ProductionOrder]
                SET [actual_start] = @date_start, 
                    [status] = 'Active',
                    [updated_at] = GETDATE(), 
                    [group] = @group
                WHERE id = @id`);
      return res.json({
        rowsAffected: result.rowsAffected,
        message: "Order status changed to Active.",
      });
    } else if (currentStatus === "Active") {
      if (groupSelection && Object.keys(groupSelection).length > 0) {
        const splitPO = await saveSplitOrders(
          pool,
          id,
          currentProduct,
          currentQty,
          dateStart,
          dateEnd,
          currentStart,
          date,
          currentPlant,
          currentLine,
          groupSelection
        );
        return res.json({
          message: "Order successfully split.",
          splitPO: splitPO, // The split orders are returned here
        });
      } else {
        const result = await pool
          .request()
          .input("id", sql.BigInt, id)
          .input("date_end", sql.DateTime, date)
          .query(`UPDATE [dbo].[ProductionOrder]
                SET [status] = 'Completed',
                    [actual_end] = @date_end,
                    [updated_at] = GETDATE(),
                    completion_count = completion_count + 1
                WHERE id = @id`);
        return res.json({
          rowsAffected: result.rowsAffected,
          message: "Order status changed to Completed.",
        });
      }
    } else if (currentStatus === "Completed") {
      const result = await pool
        .request()
        .input("id", sql.BigInt, id)
        .input("productId", sql.Int, currentProduct)
        .input("qty", sql.Int, currentQty)
        .input("startDate", sql.DateTime, dateStart)
        .input("endDate", sql.DateTime, dateEnd)
        .input("actual_start", sql.DateTime, date)
        .input("actual_end", sql.DateTime, endTime)
        .input("plant", sql.VarChar, currentPlant)
        .input("line", sql.VarChar, currentLine)
        .input("group", sql.Int, groupId).query(` DECLARE @new_id BIGINT;
              DECLARE @base_id BIGINT = @id;
              DECLARE @suffix INT = 1;

              WHILE EXISTS (
                SELECT 1 
                FROM [dbo].[ProductionOrder]
                WHERE id = CAST(@base_id AS VARCHAR) + CAST(@suffix AS VARCHAR)
              )
              BEGIN
                  SET @suffix = @suffix + 1;  -- Increment suffix until unique
              END

              SET @new_id = CAST(@base_id AS BIGINT) * POWER(10, LEN(@suffix)) + @suffix;

              INSERT INTO [dbo].[ProductionOrder] 
              (id, product_id, qty, [date_start], [date_end], [status], [created_at], [updated_at], [actual_start], [actual_end], [plant], [line], [completion_count], [group])
              VALUES 
              (@new_id, @productId, @qty, @startDate, @endDate, 'Active', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 0, @group);`);
      return res.json({
        rowsAffected: result.rowsAffected,
        message:
          "Original order intact, new order created with trailing number.",
      });
    } else if (currentStatus.startsWith("Completed")) {
      let currentCompletionNum = 1;
      const match = currentStatus.match(/Completed (\d+)/);
      if (match) {
        currentCompletionNum = parseInt(match[1]); // Get the existing completion number
      }

      const newCompletionStatus = `Completed ${currentCompletionNum + 1}`;

      const result = await pool
        .request()
        .input("id", sql.BigInt, id)
        .input("date_start", sql.DateTime, date)
        .input("date_end", sql.DateTime, endTime)
        .input("group", sql.Int, groupId).query(`UPDATE [dbo].[ProductionOrder]
                SET [actual_start] = @date_start, 
                    [actual_end] = @date_end, 
                    [status] = 'Active',
                    [updated_at] = GETDATE(), 
                    [group] = @group
                WHERE id = @id`);

      return res.json({
        rowsAffected: result.rowsAffected,
        message: `Order status changed to ${newCompletionStatus}.`,
      });
    } else {
      return res
        .status(400)
        .send(
          "The order cannot be updated as it is not in the required status."
        );
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("An error occurred while updating the table. ");
  }
});

// API Route to get Downtime for certain Line and Shift
app.post("/getAllStoppages", async (req, res) => {
  const { line, date_start, date_end } = req.body;
  try {
    // Connect to the database
    let pool = await sql.connect(config);

    // Run the query
    const result = await pool
      .request()
      .input("line", sql.NVarChar, line)
      .input("start", sql.DateTime, date_start)
      .input("end", sql.DateTime, date_end)
      .query(
        `WITH UniqueEntries AS (
            SELECT 
                rd.id,
                rd.Date,
                fd.Week,
                fd.TypeDowntime,
                rd.Shift,
                rd.[Group],
                rd.Line,
                rd.Downtime_Category,
                rd.Mesin,
                rd.Jenis,
                rd.Keterangan,
                rd.Minutes,
                fd.datesystem,
                ROW_NUMBER() OVER (PARTITION BY 
                    rd.Date, 
                    rd.Shift, 
                    rd.Line, 
                    rd.Downtime_Category, 
                    rd.Mesin, 
                    rd.Jenis, 
                    rd.Keterangan 
                    ORDER BY fd.datesystem DESC) AS rn
            FROM dbo.tb_reasonDowntime rd
            JOIN dbo.tb_filling_downtime_all2 fd
            ON CONVERT(DATE, fd.Tanggal) = CONVERT(DATE, rd.Date)
            AND SUBSTRING(fd.No, 1, 1) = SUBSTRING(rd.Line, 6, 1)
            AND fd.TypeDowntime LIKE CONCAT('%', rd.Jenis, '%')
            WHERE rd.Date >= @start
            AND rd.Date < @end
            AND rd.Line = @line
        )

        SELECT 
            id, 
            Date, 
            Week, 
            TypeDowntime, 
            Shift, 
            [Group], 
            Line, 
            Downtime_Category, 
            Mesin, 
            Jenis, 
            Keterangan, 
            Minutes, 
            datesystem
        FROM UniqueEntries
        WHERE rn = 1 
        ORDER BY Date;`
      );

    console.log("Retrieved Downtime:", result.recordset);
    // Send the result back to the client
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/getDowntime", async (req, res) => {
  const { date_start, date_end, line } = req.body;

  try {
    let pool = await sql.connect(config);

    const result = await pool
      .request()
      .input("start", sql.DateTime, date_start)
      .input("end", sql.DateTime, date_end)
      .input("line", sql.VarChar, line)
      .query(`SELECT Date, Line, Downtime_Category, Minutes FROM dbo.tb_reasonDowntime 
    WHERE Date >= @start 
    AND Date < @end
    AND Line = @line;`);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getAllDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const query = `
      SELECT TOP 5000 id, Date, Unit, Shift, Line, [Group], Downtime_Category, Mesin, Jenis, Keterangan, Minutes 
      FROM dbo.tb_reasonDowntime 
      order by id desc;`;

    const result = await pool.request().query(query);

    console.log("Retrieved Data: ", result.recordset);
    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getDowntimeId/:id", async (req, res) => {
  const { id } = req.params;

  try {
    let pool = await sql.connect(config);

    const query = `SELECT id, Date, Downtime_Category, Mesin, Jenis, Keterangan FROM dbo.tb_reasonDowntime where id = @id;`;

    const result = await pool
      .request()
      .input("id", sql.VarChar, id)
      .query(query);

    console.log("Retrieved Downtime Data based on id: ", result.recordset);
    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getAllPerformance", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const query = `
      SELECT
        ID, 
        Tanggal, 
        LEFT(TypeDowntime, 1) AS DowntimeGroup,
        MAX(CASE WHEN TypeDowntime LIKE '%UT%' THEN Downtime ELSE NULL END) AS UnavailableTime,
        MAX(CASE WHEN TypeDowntime LIKE '%activity%' THEN Downtime ELSE NULL END) AS ProductionTime,
        MAX(CASE WHEN TypeDowntime LIKE '%operational%' THEN Downtime ELSE NULL END) AS OperationTime,
        MAX(CASE WHEN TypeDowntime LIKE '%net%' THEN Downtime ELSE NULL END) AS NPT,
        MAX(CASE WHEN TypeDowntime LIKE '%running%' THEN Downtime ELSE NULL END) AS RunningTime, 
        MAX(CASE WHEN TypeDowntime LIKE '%.available%' THEN Downtime ELSE NULL END) AS AvailableTime,
        MAX(CASE WHEN TypeDowntime LIKE '%breakdown%' THEN Downtime ELSE NULL END) AS Breakdown,
        MAX(CASE WHEN TypeDowntime LIKE '%planned stop%' THEN Downtime ELSE NULL END) AS Planned,
        MAX(CASE WHEN TypeDowntime LIKE '%process wait%' THEN Downtime ELSE NULL END) AS ProcessWaiting,
        MAX(CASE WHEN TypeDowntime LIKE '%quality%' THEN Downtime ELSE NULL END) AS QualityLoss, 
        MAX(CASE WHEN TypeDowntime LIKE '%speed%' THEN Downtime ELSE NULL END) AS SpeedLoss 
      FROM dbo.tb_filling_downtime_all2
      WHERE No LIKE '_E___'
      GROUP BY ID, Tanggal, LEFT(TypeDowntime, 1)
      order by Tanggal;`;

    const result = await pool.request().query(query);

    console.log("Retrieved Data: ", result.recordset);
    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const { parseTableFillingValues } = require("./modules");

// API Route to create Downtime
app.post("/createStoppage", async (req, res) => {
  res.setTimeout(120000); // Increase server-side timeout to 2 minutes
  const {
    date_start,
    date_end,
    date_month,
    date_week,
    shift,
    line,
    type,
    machine,
    code,
    comments,
    duration,
    group,
  } = req.body;

  // -- New Code --
  // Konversi date_start menjadi objek Date
  let newDateStart = new Date(date_start);

  // Cek shift dan tambahkan 1 detik jika sesuai
  const shiftTimes = {
    I: "06:00:00.000Z",
    II: "14:00:00.000Z",
    III: "22:00:00.000Z",
  };

  // Ambil bagian jam dari date_start dalam format "HH:mm:ss.SSSZ"
  let startTime = newDateStart.toISOString().split("T")[1];

  if (shiftTimes[shift] && startTime === shiftTimes[shift]) {
    newDateStart.setSeconds(newDateStart.getSeconds() + 1);
  }
  // -- End New Code --

  let pool;
  let transaction;

  try {
    pool = await sql.connect(config);
    const overlapCheck = await pool
      .request()
      .input("newEndTime", sql.DateTime, date_end)
      .input("newStartTime", sql.DateTime, newDateStart) // Menggunakan newDateStart
      .input("line", sql.VarChar, line).query(`
        SELECT * FROM dbo.tb_reasonDowntime
        WHERE 
          Date < @newEndTime
          AND DATEADD(MINUTE, CAST(Minutes as FLOAT), Date) > @newStartTime
          AND Line = @line;
      `);

    if (overlapCheck.recordset.length > 0) {
      return res.status(409).json({
        message: `Conflict with existing entry. Please choose a different time range.`,
      });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    let truncatedDate = new Date(date_start);
    truncatedDate.setHours(0, 0, 0, 0); // Ensure time is reset to midnight
    const table2Data = parseTableFillingValues(
      date_start,
      line,
      machine,
      code,
      date_week,
      group
    );
    console.log("Inserting date as local time:", date_start);
    console.log("Truncated date:", truncatedDate);
    const resultReason = await transaction
      .request()
      .input("date_start", sql.DateTime, newDateStart) // Menggunakan newDateStart
      .input("date_month", sql.VarChar, date_month) // pisahkan dari date_start
      .input("date_week", sql.VarChar, date_week) // pakai date.getWeek()
      .input("shift", sql.VarChar, shift) // get shift based on date_start
      .input("group", sql.VarChar, group)
      .input("line", sql.VarChar, line) // ambil dari value params
      .input("category", sql.VarChar, code) // selection from radio button
      .input("machine", sql.VarChar, machine) // machine atau downtime yang dipilih di awal
      .input("type", sql.VarChar, type) // yang dipilih setelah memilih machine atau downtime
      .input("comments", sql.VarChar, comments)
      .input("duration", sql.Int, duration)
      .query(`INSERT INTO dbo.tb_reasonDowntime 
              (Unit
              ,Code
              ,Date
              ,Month
              ,Week
              ,Time
              ,Shift
              ,[Group]
              ,Line
              ,Downtime_Category
              ,Mesin
              ,Jenis
              ,Keterangan
              ,Minutes)
              VALUES 
              ('Filling'
              ,''
              ,@date_start
              ,@date_month
              ,@date_week
              ,''
              ,@shift
              ,@group
              ,@line
              ,@type
              ,@machine
              ,@category
              ,@comments
              ,@duration);
              SELECT SCOPE_IDENTITY() AS Id;`);
    if (
      !resultReason ||
      !resultReason.recordset ||
      resultReason.recordset.length === 0
    ) {
      console.error("Insert operation failed: ", resultReason);
      throw new Error("Insert operation failed or did not return an ID.");
    }
    const newId = resultReason.recordset[0].Id;
    console.log("New data ID added: ", newId);

    const existingEntry = await transaction
      .request()
      .input("Downtime", sql.VarChar, `%${code}%`)
      .input("DateOnly", sql.DateTime, truncatedDate)
      .input("No", sql.VarChar, `${table2Data.line}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.tb_filling_downtime_all2
              WHERE TypeDowntime LIKE @Downtime
              AND CONVERT(date, Tanggal) = @DateOnly
              AND No LIKE @No;
          `);

    if (existingEntry.recordset && existingEntry.recordset.length > 0) {
      const currentDuration = parseInt(existingEntry.recordset[0].Downtime, 10);
      const newDuration = currentDuration + duration;

      await transaction
        .request()
        .input("UpdatedDowntime", sql.VarChar, newDuration.toString())
        .input("EntryTanggal", sql.DateTime, truncatedDate)
        .input("Downtime", sql.VarChar, `%${code}%`)
        .input("No", sql.VarChar, `${table2Data.line}%`)
        .input("id", sql.VarChar, `${table2Data.id}`).query(`
                  UPDATE dbo.tb_filling_downtime_all2
                  SET Downtime = @UpdatedDowntime 
                  WHERE CONVERT(date, Tanggal) = @EntryTanggal
                  AND TypeDowntime LIKE @Downtime
                  AND No LIKE @No
                  AND ID = id
              `);
    } else {
      await transaction
        .request()
        .input("id", sql.VarChar, table2Data.id)
        .input("No", sql.VarChar, table2Data.combined)
        .input("Week", sql.VarChar, date_week)
        .input("Week2", sql.VarChar, date_week)
        .input("Tanggal", sql.DateTime, newDateStart) // Menggunakan newDateStart
        .input("TypeDowntime", sql.VarChar, table2Data.typeDowntime)
        .input("Downtime", sql.VarChar, duration.toString()).query(`
              INSERT INTO dbo.tb_filling_downtime_all2 (
              ID
              ,No
              ,Week
              ,Week2
              ,Tanggal
              ,DownTime
              ,TypeDowntime
              ,datesystem) 
              VALUES (
              @id
              ,@No
              ,@Week
              ,@Week2
              ,@Tanggal
              ,@Downtime
              ,@TypeDowntime
              ,GETDATE());
          `);
    }

    // Commit transaction if all operations succeed
    await transaction.commit();

    res
      .status(201)
      .json({ message: "Stoppage created successfully", id: newId });
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error("Transaction failed. Rolling back changes.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

const { parseLineDowntime } = require("./modules");

app.put("/updateStoppage", async (req, res) => {
  res.setTimeout(120000);
  const {
    id,
    date_start,
    date_end,
    date_month,
    date_week,
    shift,
    line,
    type,
    machine,
    code,
    comments,
    duration,
    group,
  } = req.body;
  let pool;
  let transaction;

  try {
    pool = await sql.connect(config);

    let currentDowntime = 0;

    const statusResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query(
        `SELECT id, Minutes FROM [dbo].[tb_reasonDowntime] WHERE id = @id`
      );

    if (statusResult.recordset.length > 0) {
      currentDowntime = parseInt(statusResult.recordset[0].Minutes);
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    let truncatedDate = new Date(date_start);
    truncatedDate.setHours(0, 0, 0, 0); // Ensure time is reset to midnight
    const dateStart = new Date(date_start);
    if (isNaN(dateStart)) {
      return res.status(400).json({ message: "Invalid date_start format" });
    }
    const table2Data = parseLineDowntime(line, dateStart, date_week);
    console.log("Inserting date as local time:", date_start);
    console.log("Downtime Category: ", type);
    const resultReason = await transaction
      .request()
      .input("id", sql.Int, parseInt(id))
      .input("date_start", sql.DateTime, date_start)
      .input("category", sql.VarChar, type)
      .input("comments", sql.VarChar, comments)
      .input("duration", sql.Int, duration).query(`UPDATE dbo.tb_reasonDowntime 
              SET Date = @date_start, 
              Downtime_Category = @category, 
              Keterangan = @comments, 
              Minutes = @duration
              WHERE id = @id;
              `);
    if (resultReason.rowsAffected[0] === 0) {
      console.error(
        "No rows were updated. Check if the ID exists:",
        resultReason
      );
      throw new Error("No matching record found for the given ID.");
    }

    const existingEntry = await transaction
      .request()
      .input("Downtime", sql.VarChar, `%${code}%`)
      .input("DateOnly", sql.DateTime, truncatedDate)
      .input("No", sql.VarChar, `${table2Data.line}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.tb_filling_downtime_all2
              WHERE TypeDowntime LIKE @Downtime
              AND CONVERT(date, Tanggal) = @DateOnly
              AND No LIKE @No;
          `);

    if (existingEntry.recordset && existingEntry.recordset.length > 0) {
      const currentDuration = parseInt(existingEntry.recordset[0].Downtime, 10);
      const newDuration = currentDuration + duration - currentDowntime;

      await transaction
        .request()
        .input("UpdatedDowntime", sql.VarChar, newDuration.toString())
        .input("EntryTanggal", sql.DateTime, truncatedDate)
        .input("Downtime", sql.VarChar, `%${code}%`)
        .input("No", sql.VarChar, `${table2Data.line}%`)
        .input("id", sql.VarChar, `${table2Data.id}`).query(`
                  UPDATE dbo.tb_filling_downtime_all2
                  SET Downtime = @UpdatedDowntime 
                  WHERE CONVERT(date, Tanggal) = @EntryTanggal
                  AND TypeDowntime LIKE @Downtime
                  AND No LIKE @No
                  AND ID = id
              `);
    }

    await transaction.commit();

    res.status(201).json({ message: "Stoppage updated successfully" });
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error("Transaction failed. Rolling back changes.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

// API Route to remove downtime
app.post("/deleteStoppage", async (req, res) => {
  const { id } = req.body;

  try {
    const pool = await sql.connect(config);
    const statusResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`SELECT * FROM [dbo].[tb_reasonDowntime] WHERE id = @id`);

    if (statusResult.recordset.length > 0) {
      const stoppageDetails = statusResult.recordset[0];
      const result = await pool
        .request()
        .input("id", sql.Int, id)
        .query(`DELETE FROM [dbo].[tb_reasonDowntime] WHERE id = @id`);
      console.log("Delete result:", result);

      // Check for rowsAffected
      const rowsAffected = result.rowsAffected[0] || 0;

      let truncatedDate = new Date(stoppageDetails.Date);
      truncatedDate.setHours(0, 0, 0, 0);
      const parsedLine = parseLineDowntime(
        stoppageDetails.Line,
        stoppageDetails.Date,
        stoppageDetails.Week
      );
      const existingEntry = await pool
        .request()
        .input("Downtime", sql.VarChar, `%${stoppageDetails.Jenis}%`)
        .input("DateOnly", sql.DateTime, truncatedDate)
        .input("No", sql.VarChar, `${parsedLine.line}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.tb_filling_downtime_all2
              WHERE TypeDowntime LIKE @Downtime
              AND CONVERT(date, Tanggal) = @DateOnly
              AND No LIKE @No;
      `);

      console.log("Existing entry: ", existingEntry.recordset);

      if (existingEntry.recordset && existingEntry.recordset.length > 0) {
        const currentDuration = parseInt(
          existingEntry.recordset[0].Downtime,
          10
        );
        const reducedDuration = parseInt(stoppageDetails.Minutes, 10);
        const newDuration = Math.max(0, currentDuration - reducedDuration);

        console.log({
          UpdatedDowntime: newDuration.toString(),
          EntryTanggal: truncatedDate,
          Downtime: `%${stoppageDetails.Jenis}%`,
          No: `${parsedLine.line}%`,
          ID: `${parsedLine.id}`,
        });

        const updatedResult = await pool
          .request()
          .input("UpdatedDowntime", sql.VarChar, newDuration.toString())
          .input("EntryTanggal", sql.DateTime, truncatedDate)
          .input("Downtime", sql.VarChar, `%${stoppageDetails.Jenis}%`)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("id", sql.VarChar, `${parsedLine.id}`).query(`
                  UPDATE dbo.tb_filling_downtime_all2
                  SET Downtime = @UpdatedDowntime 
                  WHERE CONVERT(date, Tanggal) = @EntryTanggal
                  AND TypeDowntime LIKE @Downtime
                  AND No LIKE @No
                  AND ID = @id;
              `);
        if (updatedResult.rowsAffected[0] > 0) {
          console.log("Downtime updated successfully.");
        } else {
          console.error("No rows were updated. Check query conditions.");
        }
      }

      // Send the result back with rowsAffected as a number
      return res.json({
        success: true,
        rowsAffected: rowsAffected,
        message: "Downtime data has been deleted",
      });
    } else {
      return res.status(404).json({ error: "Downtime entry not found" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("An error occurred while updating the table. ");
  }
});

// API Route to get Downtime Category
app.get("/getDowntimeCategory", async (req, res) => {
  try {
    let pool = await sql.connect(config);
    const result = await pool
      .request()
      .query(`SELECT DISTINCT downtime_category FROM DowntimeMaster`);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching downtime categories:", error);
    res.status(500).send("Server Error");
  }
});

// API Route to get Downtime Types based on category
app.get("/getDowntimeType/:cat/:line", async (req, res) => {
  const { cat, line } = req.params;
  try {
    let pool = await sql.connect(config);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("cat", sql.NVarChar, cat)
      .input("line", sql.NVarChar, lineInitial)
      .query(
        "SELECT mesin, downtime FROM DowntimeMaster WHERE downtime_category = @cat AND line = @line"
      );
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching machines by category:", error);
    res.status(500).send("Server Error");
  }
});

const { parseLine } = require("./modules");

app.post("/insertQuantity", async (req, res) => {
  const { qty, line, startTime, date_week, group } = req.body;
  // console.log("Received Data: \n", qty, line, startTime, date_week, group);

  let pool;
  let result;
  try {
    pool = await sql.connect(config);
    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week);

    const goodValue = qty ? qty.toString() : "0";
    const existingEntry = await pool
      .request()
      .input("DateOnly", sql.DateTime, parsedDateStart)
      .input("No", sql.VarChar, `${parsedLine.line}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.tb_filling_downtime_all2
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE '%good%'
              AND No LIKE @No;
          `);

    if (existingEntry.recordset && existingEntry.recordset.length > 0) {
      result = await pool
        .request()
        .input("UpdatedQuantity", sql.VarChar, goodValue)
        .input("DateOnly", sql.DateTime, parsedDateStart)
        .input("No", sql.VarChar, `${parsedLine.line}%`)
        .query(`UPDATE dbo.tb_filling_downtime_all2
                  SET Downtime = @UpdatedQuantity 
                  WHERE Tanggal = @DateOnly
                  AND TypeDowntime LIKE '%good%'
                  AND No LIKE @No
            `);
    } else {
      result = await pool
        .request()
        .input("id", sql.VarChar, parsedLine.id)
        .input("No", sql.VarChar, parsedLine.combined)
        .input("Week", sql.VarChar, date_week)
        .input("Week2", sql.VarChar, date_week)
        .input("Tanggal", sql.DateTime, parsedDateStart)
        .input("good", sql.VarChar, goodValue)
        .input("group", sql.VarChar, `${group}.Finish Good (Pcs)`)
        .query(`INSERT INTO dbo.tb_filling_downtime_all2 (
                ID
                ,No
                ,Week
                ,Week2
                ,Tanggal
                ,DownTime
                ,TypeDowntime
                ,datesystem) 
                VALUES (
                @id
                ,@No
                ,@Week
                ,@Week2
                ,@Tanggal
                ,@good
                ,@group
                ,GETDATE());`);
    }
    return res.json({
      rowsAffected: result.rowsAffected,
      message: "Successfully added Quantity",
    });
  } catch (error) {
    console.error("Insertion failed. Rolling back changes.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.post("/insertSpeedLoss", async (req, res) => {
  const { speed, nominal, line, startTime, date_week, group } = req.body;
  // console.log("Received Data: \n", speed, line, startTime, date_week, group);

  let pool;
  try {
    pool = await sql.connect(config);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week);

    const speedValue = speed ? speed.toString() : "0";
    const nominalValue = nominal ? nominal.toString() : "0";

    const upsertData = async (type, value) => {
      if (value === null || value === undefined || isNaN(parseFloat(value))) {
        return; // Skip invalid or missing data
      }

      const existingEntry = await pool
        .request()
        .input("DateOnly", sql.DateTime, parsedDateStart)
        .input("No", sql.VarChar, `${parsedLine.line}%`)
        .input("TypeDowntime", sql.VarChar, `%${type}%`).query(`
          SELECT Downtime FROM dbo.tb_filling_downtime_all2
          WHERE Tanggal = @DateOnly
          AND TypeDowntime LIKE @TypeDowntime
          AND No LIKE @No;
        `);

      if (existingEntry.recordset && existingEntry.recordset.length > 0) {
        await pool
          .request()
          .input("NewDowntime", sql.VarChar, value.toString())
          .input("DateOnly", sql.DateTime, parsedDateStart)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("TypeDowntime", sql.VarChar, `%${type}%`)
          .input("Type", sql.VarChar, `${group}.${type}`).query(`
              UPDATE dbo.tb_filling_downtime_all2
              SET Downtime = @NewDowntime, 
                  TypeDowntime = @Type
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE @TypeDowntime
              AND No LIKE @No;
            `);
      } else {
        await pool
          .request()
          .input("id", sql.VarChar, parsedLine.id)
          .input("No", sql.VarChar, parsedLine.combined)
          .input("Week", sql.VarChar, date_week)
          .input("Week2", sql.VarChar, date_week)
          .input("Tanggal", sql.DateTime, parsedDateStart)
          .input("Value", sql.VarChar, value.toString())
          .input("TypeDowntime", sql.VarChar, `${group}.${type}`).query(`
              INSERT INTO dbo.tb_filling_downtime_all2 (
                ID
                ,No
                ,Week
                ,Week2
                ,Tanggal
                ,Downtime
                ,TypeDowntime
                ,datesystem) 
              VALUES (
                @id
                ,@No
                ,@Week
                ,@Week2
                ,@Tanggal
                ,@Value
                ,@TypeDowntime
                ,GETDATE());
            `);
      }
    };

    await upsertData("LOSS SPEED", speedValue);
    await upsertData("NOMINAL SPEED", nominalValue);
    return res.json({
      message: "Successfully updated or added Loss Speed Data",
    });
  } catch (error) {
    console.error("Insertion failed. Rolling back changes.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.post("/deleteSpeedLoss", async (req, res) => {
  const { startTime, line } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const lineInitial = line.charAt(5).toUpperCase();
    const statusResult = await pool
      .request()
      .input("date", sql.DateTime, parsedDateStart)
      .input("line", sql.VarChar, `${lineInitial}E%`)
      .query(
        `SELECT * FROM [dbo].[tb_filling_downtime_all2] WHERE Tanggal = @date AND TypeDowntime LIKE '%SPEED%' AND No LIKE @line`
      );

    if (statusResult.recordset.length > 0) {
      const result = await pool
        .request()
        .input("date", sql.DateTime, parsedDateStart)
        .input("line", sql.VarChar, `${lineInitial}E%`)
        .query(
          `DELETE FROM [dbo].[tb_filling_downtime_all2] WHERE Tanggal = @date AND TypeDowntime LIKE '%SPEED%' AND No LIKE @line`
        );
      console.log("Delete result:", result);
      const rowsAffected = result.rowsAffected[0] || 0;

      return res.json({
        success: true,
        rowsAffected: rowsAffected,
        message: "Speed Loss data has been deleted",
      });
    } else {
      return res.status(404).json({ error: "Speed Loss entry not found" });
    }
  } catch (error) {
    console.error("Deletion failed. Rolling back changes.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/insertQualLoss", async (req, res) => {
  const {
    filling,
    packing,
    sample,
    quality,
    line,
    startTime,
    date_week,
    group,
  } = req.body;
  console.log(
    "Received Data: \n",
    filling,
    packing,
    sample,
    quality,
    line,
    startTime,
    date_week,
    group
  );

  let pool;
  try {
    pool = await sql.connect(config);
    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart.getTime())) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week);

    const fillingValue = filling ? filling.toString() : "0";
    const packingValue = packing ? packing.toString() : "0";
    const sampleValue = sample ? sample.toString() : "0";
    const qualityValue = quality ? quality.toString() : "0";

    const upsertData = async (type, value) => {
      if (value === null || value === undefined || isNaN(parseFloat(value))) {
        return; // Skip invalid or missing data
      }
      const existingEntry = await pool
        .request()
        .input("DateOnly", sql.DateTime, parsedDateStart)
        .input("No", sql.VarChar, `${parsedLine.line}%`)
        .input("TypeDowntime", sql.VarChar, `%${type}%`).query(`
          SELECT Downtime FROM dbo.tb_filling_downtime_all2
          WHERE Tanggal = @DateOnly
          AND TypeDowntime LIKE @TypeDowntime
          AND No LIKE @No;
        `);

      if (existingEntry.recordset && existingEntry.recordset.length > 0) {
        // Update existing entry
        await pool
          .request()
          .input("NewDowntime", sql.VarChar, value.toString())
          .input("DateOnly", sql.DateTime, parsedDateStart)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("TypeDowntime", sql.VarChar, `%${type}%`)
          .input("Type", sql.VarChar, `${group}.${type}`).query(`
              UPDATE dbo.tb_filling_downtime_all2
              SET Downtime = @NewDowntime, 
                  TypeDowntime = @Type
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE @TypeDowntime
              AND No LIKE @No;
            `);
      } else {
        await pool
          .request()
          .input("id", sql.VarChar, parsedLine.id)
          .input("No", sql.VarChar, parsedLine.combined)
          .input("Week", sql.VarChar, date_week)
          .input("Week2", sql.VarChar, date_week)
          .input("Tanggal", sql.DateTime, parsedDateStart)
          .input("Value", sql.VarChar, value.toString())
          .input("TypeDowntime", sql.VarChar, `${group}.${type}`).query(`
              INSERT INTO dbo.tb_filling_downtime_all2 (
                ID
                ,No
                ,Week
                ,Week2
                ,Tanggal
                ,Downtime
                ,TypeDowntime
                ,datesystem) 
              VALUES (
                @id
                ,@No
                ,@Week
                ,@Week2
                ,@Tanggal
                ,@Value
                ,@TypeDowntime
                ,GETDATE());
            `);
      }
    };

    await upsertData("Reject filling(Pcs)", fillingValue);
    await upsertData("Reject packing (Pcs)", packingValue);
    await upsertData("Sample (pcs)", sampleValue);
    await upsertData("Quality Losses", qualityValue);
    return res.json({
      message:
        "Successfully updated or added Reject Filling, Reject Packing, Sample, and Quality Losses Data",
    });
  } catch (error) {
    console.error("Insertion of Quality Loss related data failed", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.post("/insertPerformance", async (req, res) => {
  const {
    net,
    running,
    production,
    operation,
    nReported,
    available,
    breakdown,
    processwait,
    planned,
    ut,
    startTime,
    date_week,
    line,
    group,
  } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);
    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart.getTime())) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week);

    const netValue = net ? net.toString() : "0";
    const runningValue = running ? running.toString() : "0";
    const productionValue = production ? production.toString() : "0";
    const operationValue = operation ? operation.toString() : "0";
    const availableValue = available ? available.toString() : "0";
    const breakdownValue = breakdown ? breakdown.toString() : "0";
    const processwaitValue = processwait ? processwait.toString() : "0";
    const plannedValue = planned ? planned.toString() : "0";
    const nReportedValue = nReported ? nReported.toString() : "0";
    const utValue = ut ? ut.toString() : "0";

    const truncatedDate = new Date(parsedDateStart);
    truncatedDate.setHours(0, 0, 0, 0);

    if (isNaN(truncatedDate.getTime())) {
      return res.status(400).json({ message: "Invalid truncatedDate" });
    }

    console.log("Final truncatedDate:", truncatedDate);

    const upsertData = async (type, value) => {
      if (value === null || value === undefined || isNaN(parseFloat(value))) {
        return; // Skip invalid or missing data
      }
      let existingEntry;
      if (type === "UT-No PO") {
        existingEntry = await pool
          .request()
          .input("DateOnly", sql.DateTime, parsedDateStart)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("TypeDowntime", sql.VarChar, `%${type}%`).query(`
          SELECT Downtime FROM dbo.tb_filling_downtime_all2
          WHERE Tanggal = @DateOnly
          AND TypeDowntime LIKE @TypeDowntime
          AND No LIKE @No;
        `);
      } else {
        existingEntry = await pool
          .request()
          .input("DateOnly", sql.DateTime, parsedDateStart)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("TypeDowntime", sql.VarChar, `%${type}%`).query(`
          SELECT Downtime FROM dbo.tb_filling_downtime_all2
          WHERE Tanggal = @DateOnly
          AND TypeDowntime LIKE @TypeDowntime
          AND No LIKE @No;
        `);
      }

      if (existingEntry.recordset && existingEntry.recordset.length > 0) {
        if (type === "UT-No PO") {
          await pool
            .request()
            .input("NewDowntime", sql.VarChar, value.toString())
            .input("DateOnly", sql.DateTime, parsedDateStart)
            .input("No", sql.VarChar, `${parsedLine.line}%`)
            .input("TypeDowntime", sql.VarChar, `%${type}%`)
            .input("Type", sql.VarChar, `${type}`).query(`
              UPDATE dbo.tb_filling_downtime_all2
              SET Downtime = @NewDowntime,
              TypeDowntime = @Type
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE @TypeDowntime
              AND No LIKE @No;
            `);
        } else {
          await pool
            .request()
            .input("NewDowntime", sql.VarChar, value.toString())
            .input("DateOnly", sql.DateTime, parsedDateStart)
            .input("No", sql.VarChar, `${parsedLine.line}%`)
            .input("TypeDowntime", sql.VarChar, `%${type}%`)
            .input("Type", sql.VarChar, `${group}.${type}`).query(`
              UPDATE dbo.tb_filling_downtime_all2
              SET Downtime = @NewDowntime,
              TypeDowntime = @Type
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE @TypeDowntime
              AND No LIKE @No;
            `);
        }
      } else {
        if (type === "UT-No PO") {
          await pool
            .request()
            .input("id", sql.VarChar, parsedLine.id)
            .input("No", sql.VarChar, parsedLine.combined)
            .input("Week", sql.VarChar, date_week)
            .input("Week2", sql.VarChar, date_week)
            .input("Tanggal", sql.DateTime, parsedDateStart)
            .input("Value", sql.VarChar, value.toString())
            .input("TypeDowntime", sql.VarChar, `${type}`).query(`
              INSERT INTO dbo.tb_filling_downtime_all2 (
                ID
                ,No
                ,Week
                ,Week2
                ,Tanggal
                ,Downtime
                ,TypeDowntime
                ,datesystem) 
              VALUES (
                @id
                ,@No
                ,@Week
                ,@Week2
                ,@Tanggal
                ,@Value
                ,@TypeDowntime
                ,GETDATE());
            `);
        } else {
          await pool
            .request()
            .input("id", sql.VarChar, parsedLine.id)
            .input("No", sql.VarChar, parsedLine.combined)
            .input("Week", sql.VarChar, date_week)
            .input("Week2", sql.VarChar, date_week)
            .input("Tanggal", sql.DateTime, parsedDateStart)
            .input("Value", sql.VarChar, value.toString())
            .input("TypeDowntime", sql.VarChar, `${group}.${type}`).query(`
              INSERT INTO dbo.tb_filling_downtime_all2 (
                ID
                ,No
                ,Week
                ,Week2
                ,Tanggal
                ,Downtime
                ,TypeDowntime
                ,datesystem) 
              VALUES (
                @id
                ,@No
                ,@Week
                ,@Week2
                ,@Tanggal
                ,@Value
                ,@TypeDowntime
                ,GETDATE());
            `);
        }
      }
    };

    await upsertData("Net Prod. Time", netValue);
    await upsertData("Ideal Running Time", runningValue);
    await upsertData("Operational Time", operationValue);
    await upsertData("PROD ACTIVITY", productionValue);
    await upsertData("Available Time", availableValue);
    await upsertData("BREAKDOWN PROCESS FAILURE MINOR STOP", breakdownValue);
    await upsertData("PROCESS WAITING", processwaitValue);
    await upsertData("PLANNED STOP", plannedValue);
    await upsertData("NOT REPORTED", nReportedValue);
    await upsertData("UT-No PO", utValue);
  } catch (error) {
    console.error("Insertion of performance data failed", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.post("/getQualityLoss", async (req, res) => {
  const { line, date_start, date_end } = req.body;
  try {
    let pool = await sql.connect(config);
    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    console.log("Parsed Date Start: ", parsedDateStart);

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    console.log("Parsed Date End: ", parsedDateEnd);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.tb_filling_downtime_all2 
      WHERE TypeDowntime LIKE '%Quality%' 
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getRejectSample", async (req, res) => {
  const { line, date_start, date_end } = req.body;
  try {
    let pool = await sql.connect(config);
    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    console.log("Parsed Date Start: ", parsedDateStart);

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    console.log("Parsed Date End: ", parsedDateEnd);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.tb_filling_downtime_all2 
      WHERE (TypeDowntime LIKE '%reject%'
      OR TypeDowntime LIKE '%sample%')
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getSpeedLoss", async (req, res) => {
  const { line, date_start, date_end } = req.body;

  try {
    let pool = await sql.connect(config);
    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    console.log("Parsed Date Start: ", parsedDateStart);

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    console.log("Parsed Date End: ", parsedDateEnd);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.tb_filling_downtime_all2 
      WHERE TypeDowntime LIKE '%LOSS SPEED%' 
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getNominalSpeed", async (req, res) => {
  const { line, date_start, date_end } = req.body;
  try {
    let pool = await sql.connect(config);
    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    console.log("Parsed Date Start: ", parsedDateStart);

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    console.log("Parsed Date End: ", parsedDateEnd);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Tanggal, Downtime FROM dbo.tb_filling_downtime_all2 
      WHERE TypeDowntime LIKE '%NOMINAL SPEED%'
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getQuantity", async (req, res) => {
  const { line, date_start, date_end } = req.body;

  try {
    let pool = await sql.connect(config);
    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    console.log("Parsed Date Start: ", parsedDateStart);

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    console.log("Parsed Date End: ", parsedDateEnd);

    const lineInitial = line.charAt(5).toUpperCase();

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.tb_filling_downtime_all2 
      WHERE TypeDowntime LIKE '%Good%' 
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

// API Route to get master Product data
app.get("/getCatProd/:cat", async (req, res) => {
  const { cat } = req.params;

  try {
    let pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("cat", sql.NVarChar, cat)
      .query("SELECT id, sku FROM Product WHERE category = @cat");
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
  }
});

app.get("/getProducts", async (req, res) => {
  const { ids } = req.query; // Ambil query parameter 'ids'

  if (!ids) {
    return res.status(400).json({ error: "Product IDs are required" });
  }

  // Ubah string "1,2,3" menjadi array angka [1, 2, 3]
  const idArray = ids
    .split(",")
    .map((id) => parseInt(id.trim()))
    .filter(Boolean);

  try {
    let pool = await sql.connect(config);

    // Pastikan array tidak kosong sebelum menjalankan query
    if (idArray.length === 0) {
      return res.status(400).json({ error: "Invalid Product IDs" });
    }

    // Gunakan parameterized query untuk keamanan
    const request = pool.request();
    idArray.forEach((id, index) => {
      request.input(`id${index}`, sql.Int, id);
    });

    const query = `SELECT id, sku, speed FROM Product WHERE id IN (${idArray
      .map((_, i) => `@id${i}`)
      .join(",")})`;
    const result = await request.query(query);
    console.log("Retrieved Products:", result.recordset);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// app.get('/getAllPOOLD/:line', async (req, res) => {
//   const { line } = req.params;
//   try {
//     // Connect to the database
//     let pool = await sql.connect(config);

//     // Run the query
//     const result = await pool
//       .request()
//       .input("line", sql.VarChar, line)
//       .query(`SELECT PO.id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.plant, PO.line
//         FROM ProductionOrder PO
//         INNER JOIN Product P
//         ON PO.product_id = P.id
//         AND PO.line = @line
//         ORDER BY status desc;`);

//       console.log("Retrieved Production Order:", result.recordset);
//     // Send the result back to the client
//     res.status(200).json(result.recordset);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: 'Internal Server Error' });
//   }
// });

// app.post('/createEmptyPOOLD', async (req, res) => {
//   const { date_start, date_end, plant, line, group } = req.body;

//   try {
//     let pool = await sql.connect(config);

//     const groupResult = await pool
//     .request()
//     .input("group", sql.VarChar, group)
//     .query('SELECT id FROM GroupMaster WHERE [group] = @group;');

//     const groupId = groupResult.recordset[0]?.id;

//     if (!groupId) {
//       return res.status(400).json({ message: 'Invalid group provided.' });
//     }

//     let baseId = 666666000000;
//     let idExists = true;

//     while (idExists) {
//       const idCheckResult = await pool
//         .request()
//         .input("id", sql.BigInt, baseId)
//         .query('SELECT 1 FROM [dbo].[ProductionOrder] WHERE id = @id;');

//       if (idCheckResult.recordset.length === 0) {
//         idExists = false; // Unique ID found
//       } else {
//         baseId++; // Increment ID
//       }
//     }

//     const insertOrderQuery = `
//       INSERT INTO [dbo].[ProductionOrder]
//       (
//         id, product_id, qty, date_start, date_end, status, created_at, updated_at, actual_start, actual_end, plant, line, completion_count, [group]
//       )
//       VALUES (
//         @id, 100, 0, @start, @end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 1, @group
//       )
//     `;
//     const orderResult = await pool
//       .request()
//       .input("id", sql.BigInt, baseId)
//       .input("start", sql.DateTime, date_start)
//       .input("end", sql.DateTime, date_end)
//       .input("actual_start", sql.DateTime, date_start)
//       .input("actual_end", sql.DateTime, date_end)
//       .input("plant", sql.VarChar, plant)
//       .input("line", sql.VarChar, line.toUpperCase())
//       .input("group", sql.Int, groupId)
//       .query(insertOrderQuery);

//     if (orderResult.rowsAffected[0] === 0) {
//       throw new Error('Failed to insert production order.');
//     }

//     return res.json({ rowsAffected: orderResult.rowsAffected, message: "Successfully created PO for UT-No PO insertion", id: baseId });
//   } catch (error) {
//     console.error('Error occurred:', error.message);
//     res.status(500).json({ message: 'Internal Server Error' });
//   }
// });
