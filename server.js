require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const config = require("./config");
const moment = require("moment");
const logger = require("./logger");

const app = express();
const port = process.env.PORT_1 | 3001;
app.use(cors());
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

    const uniqueYogurtItems = Array.from(
      new Map(
        selectedData
          .filter((item) => item.plant === "Yogurt")
          .map((item) => [item.line, item])
      ).values()
    );

    const uniqueCheeseItems = Array.from(
      new Map(
        selectedData
          .filter((item) => item.plant === "Cheese")
          .map((item) => [item.line, item])
      ).values()
    );

    const finalData = uniqueProcessingItems
      .concat(uniqueFillingItems)
      .concat(uniqueYogurtItems)
      .concat(uniqueCheeseItems);
    res.json(finalData);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching data");
  }
});

const {
  formatDateTime,
  getOrCreateProduct,
  getTableName,
  getTablePerformName,
  getViewFinishGoodLiter,
  getProductionName,
  parseLineSpeedLoss,
  parseLineWIB,
  parseLineInitial,
} = require("./modules");

// insert PO from SAP to local database
app.post("/createPO", async (req, res) => {
  const { id, date, line, group, plant, date_week } = req.body;

  try {
    const pool = await sql.connect(config);
    const groupResult = await pool
      .request()
      .input("group", sql.VarChar, group)
      .input("plant", sql.VarChar, plant)
      .query(
        "SELECT id FROM GroupMaster WHERE [group] = @group AND plant = @plant;"
      );

    const groupId = groupResult.recordset[0]?.id;

    let allData;
    if (plant === "Yogurt" && line === "PASTEURIZER") {
      allData = await getLocalPasteurizerOrder(plant, line);
    } else {
      allData = await getProductDummy(plant);
    }
    const record = allData.find((item) => item["NO PROCESS ORDER"] === id);

    if (!record) {
      return res
        .status(404)
        .json({ message: `Record with NO PROCESS ORDER ${id} not found.` });
    }

    const baseId = Date.now();

    const {
      "NO PROCESS ORDER": noProcessOrder,
      MATERIAL: material,
      "TANGGAL SCHEDULED START": startDate,
      "TIME SCHEDULED START": startTime,
      "TANGGAL SCHEDULED END": endDate,
      "TIME SCHEDULED END": endTime,
      "TOTAL QUANTITY / GR": qty,
    } = record;

    const finalProcessOrderId =
      plant === "Milk Processing" ||
      plant === "Yogurt" ||
      plant === "Cheese" ||
      plant === "Milk Filling Packing"
        ? baseId.toString()
        : noProcessOrder;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "Invalid date format or missing date." });
    }

    const localDateTimeStart = formatDateTime(startDate, startTime);
    const localDateTimeEnd = formatDateTime(endDate, endTime);

    const cleanedQty = qty.replace(/,/g, "");
    let finalQtyInt;

    if (qty.includes(",") || qty.includes(".")) {
      // If the number has a comma or decimal, multiply by 1000 if the decimal is present
      finalQtyInt = cleanedQty.includes(".")
        ? parseFloat(cleanedQty) * 1000
        : parseInt(cleanedQty);
    } else {
      finalQtyInt = parseInt(cleanedQty);
    }

    const productId = await getOrCreateProduct(pool, material);

    const existingOrderQuery = `
      SELECT id FROM ProductionOrder WHERE id = @po
    `;
    const existingOrder = await pool
      .request()
      .input("po", sql.BigInt, parseInt(finalProcessOrderId, 10))
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
        @id, @product, @qty, @start, @end, 'Active', GETDATE(), GETDATE(), @actual, NULL, @plant, @line, 0, @group
      )
    `;
    const orderResult = await pool
      .request()
      .input("id", sql.BigInt, parseInt(finalProcessOrderId, 10))
      .input("product", sql.Int, productId)
      .input("qty", sql.Int, finalQtyInt)
      .input("start", sql.DateTime, localDateTimeStart)
      .input("end", sql.DateTime, localDateTimeEnd)
      .input("actual", sql.DateTime, date)
      .input("line", sql.VarChar, line.toUpperCase())
      .input("group", sql.Int, groupId)
      .input("plant", sql.VarChar, plant)
      .query(insertOrderQuery);

    if (orderResult.rowsAffected[0] === 0) {
      throw new Error("Failed to insert production order.");
    }

    const parsedDateStart = new Date(date);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedLine = parseLine(line, parsedDateStart, date_week, plant);

    const skuResult = await pool
      .request()
      .input("id", sql.VarChar, parsedLine.id)
      .input("No", sql.VarChar, parsedLine.combined)
      .input("Week", sql.VarChar, date_week)
      .input("Week2", sql.VarChar, date_week)
      .input("Tanggal", sql.DateTime, parsedDateStart)
      .input("group", sql.VarChar, `${group}.SKU.${material}`)
      .query(`INSERT INTO dbo.${tableName} (
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
                ,0
                ,@group
                ,GETDATE());`);

    if (skuResult.rowsAffected[0] === 0) {
      throw new Error("Failed to insert SKU.");
    }

    return res.json({
      id: finalProcessOrderId,
      rowsAffected: orderResult.rowsAffected,
      message: "Successfully inserted PO to local database",
    });
  } catch (error) {
    console.error("Error create PO:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Create empty PO with No PO as the product for UT-No PO insertion
app.post("/createEmptyPO", async (req, res) => {
  const { date_start, date_end, plant, line, groupSelection } = req.body;

  try {
    let pool = await sql.connect(config);

    const baseId = Date.now();

    const groupResult = await pool
      .request()
      .input("group", sql.VarChar, groupSelection)
      .input("plant", sql.VarChar, plant)
      .query(
        "SELECT id FROM GroupMaster WHERE [group] = @group AND plant = @plant;"
      );

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
        @id, 131, 0, @start, @end, 'Completed', GETDATE(), GETDATE(), @actual_start, @actual_end, @plant, @line, 1, @group
      )
    `;

    const insertOrderQuery = await pool
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
      .query(`SELECT PO.id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.plant, PO.line, PO.[group]  
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
      .query(`SELECT PO.id, PO.product_id, P.sku, PO.qty, PO.date_start, PO.date_end, PO.status, PO.actual_start, PO.actual_end, PO.plant, PO.line, PO.[group]
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
  const { id, actual_start, actual_end, poStart, poEnd, plant, line } =
    req.body;

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

    const tableName = getTableName(plant, line);
    const lineInitial = parseLineInitial(plant, line);
    const idInitial = `${lineInitial}EG`;

    if (actual_start) {
      const excludedSuffixes = [
        "Net Prod. Time",
        "Ideal Running Time",
        "Operational Time",
        "PROD ACTIVITY",
        "Available Time",
        "BREAKDOWN PROCESS FAILURE MINOR STOP",
        "PROCESS WAITING",
        "PLANNED STOP",
        "NOT REPORTED",
        "UT-No PO",
      ];

      const queryData = `
        UPDATE [dbo].[${tableName}]
        SET Tanggal = @actualStart
        WHERE ID LIKE @id
          AND Tanggal = @poStart
          AND NOT (
            RIGHT([TypeDowntime], LEN([TypeDowntime]) - CHARINDEX('.', [TypeDowntime])) IN (${excludedSuffixes
              .map((_, i) => `@suffix${i}`)
              .join(", ")})
          )
      `;

      const requestData = pool
        .request()
        .input("id", sql.VarChar, `${idInitial}%`)
        .input("actualStart", sql.DateTime, actual_start)
        .input("poStart", sql.DateTime, poStart);

      excludedSuffixes.forEach((val, i) => {
        requestData.input(`suffix${i}`, sql.VarChar, val);
      });

      const resultData = await requestData.query(queryData);
      if (resultData.rowsAffected[0] === 0) {
        console.error("No rows were updated. Check query conditions.");
      }
    }

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
  const { line, date_start, date_end, plant } = req.body;
  try {
    // Connect to the database
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

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
            JOIN dbo.${tableName} fd
            ON CONVERT(DATE, fd.Tanggal) = CONVERT(DATE, rd.Date)
     
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
      FROM dbo.PBI_reason_downtime
      order by id desc;`;

    const result = await pool.request().query(query);

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

    const query = `SELECT id, Date, Downtime_Category, Mesin, Jenis, Keterangan, Minutes FROM dbo.tb_reasonDowntime where id = @id;`;

    const result = await pool
      .request()
      .input("id", sql.VarChar, id)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getAllPerformance", async (req, res) => {
  const { plant, line } = req.query;

  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTablePerformName(plant, line);

    // const query = `
    //   SELECT
    //     ID,
    //     Tanggal,
    //     LEFT(TypeDowntime, 1) AS DowntimeGroup,
    //     MAX(CASE WHEN TypeDowntime LIKE '%UT%' THEN Downtime ELSE NULL END) AS UnavailableTime,
    //     MAX(CASE WHEN TypeDowntime LIKE '%activity%' THEN Downtime ELSE NULL END) AS ProductionTime,
    //     MAX(CASE WHEN TypeDowntime LIKE '%operational%' THEN Downtime ELSE NULL END) AS OperationTime,
    //     MAX(CASE WHEN TypeDowntime LIKE '%net%' THEN Downtime ELSE NULL END) AS NPT,
    //     MAX(CASE WHEN TypeDowntime LIKE '%running%' THEN Downtime ELSE NULL END) AS RunningTime,
    //     MAX(CASE WHEN TypeDowntime LIKE '%.available%' THEN Downtime ELSE NULL END) AS AvailableTime,
    //     MAX(CASE WHEN TypeDowntime LIKE '%breakdown%' THEN Downtime ELSE NULL END) AS Breakdown,
    //     MAX(CASE WHEN TypeDowntime LIKE '%planned stop%' THEN Downtime ELSE NULL END) AS Planned,
    //     MAX(CASE WHEN TypeDowntime LIKE '%process wait%' THEN Downtime ELSE NULL END) AS ProcessWaiting,
    //     MAX(CASE WHEN TypeDowntime LIKE '%quality%' THEN Downtime ELSE NULL END) AS QualityLoss,
    //     MAX(CASE WHEN TypeDowntime LIKE '%speed%' THEN Downtime ELSE NULL END) AS SpeedLoss
    //   FROM dbo.${tableName}
    //   WHERE No LIKE '_E___'
    //   GROUP BY ID, Tanggal, LEFT(TypeDowntime, 1)
    //   order by Tanggal;`;
    console.log("plant : ", plant);
    console.log("line : ", line);
    console.log("table name : ", tableName);

    const query = `
      SELECT
        *
      FROM dbo.${tableName}
      order by Tanggal2 asc;`;

    const result = await pool.request().query(query);
    // console.log("result: ", result);
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
    plant,
    cipimpact,
  } = req.body;

  const uppercasedLine = line.toUpperCase();

  // update plant name
  const updatedPlant =
    plant === "Milk Processing"
      ? "Processing"
      : plant === "Yogurt"
      ? "Yogurt"
      : plant === "Cheese"
      ? "Cheese"
      : "Filling";

  // table name based on plant
  const tableName = getTableName(plant, line);

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
      .input("line", sql.VarChar, uppercasedLine).query(`
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
      uppercasedLine,
      machine,
      code,
      date_week,
      group,
      plant
    );

    let tableCIPImpact;
    let cipStartTime;
    let cipType;
    let cipCategory;
    if (cipimpact) {
      cipType = "CIP 6 Impact";
      cipCategory = type;

      // Hitung waktu mulai untuk cipimpact: newDateStart + duration (menit)
      cipStartTime = new Date(newDateStart);
      cipStartTime.setMinutes(cipStartTime.getMinutes() + duration);

      tableCIPImpact = parseTableFillingValues(
        cipStartTime,
        uppercasedLine,
        machine,
        cipType,
        date_week,
        group,
        plant
      );
    }

    const resultReason = await transaction
      .request()
      .input("unit", sql.VarChar, updatedPlant) // untuk unit menggunakan updated plant name
      .input("date_start", sql.DateTime, newDateStart) // Menggunakan newDateStart
      .input("date_month", sql.VarChar, date_month) // pisahkan dari date_start
      .input("date_week", sql.VarChar, date_week) // pakai date.getWeek()
      .input("shift", sql.VarChar, shift) // get shift based on date_start
      .input("group", sql.VarChar, group)
      .input("line", sql.VarChar, uppercasedLine) // ambil dari value params
      .input("category", sql.VarChar, code) // selection from radio button
      .input("machine", sql.VarChar, machine) // machine atau downtime yang dipilih di awal
      .input("type", sql.VarChar, type) // yang dipilih setelah memilih machine atau downtime
      .input("comments", sql.VarChar, comments)
      .input("duration", sql.Float, duration)
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
              (@unit
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

    if (cipimpact) {
      await transaction
        .request()
        .input("unit", sql.VarChar, updatedPlant)
        .input("date_start", sql.DateTime, cipStartTime) // gunakan waktu setelah downtime utama
        .input("date_month", sql.VarChar, date_month)
        .input("date_week", sql.VarChar, date_week)
        .input("shift", sql.VarChar, shift)
        .input("group", sql.VarChar, group)
        .input("line", sql.VarChar, uppercasedLine)
        .input("category", sql.VarChar, cipType)
        .input("machine", sql.VarChar, machine)
        .input("type", sql.VarChar, cipCategory)
        .input("comments", sql.VarChar, "-")
        .input("duration", sql.Float, cipimpact)
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
            (@unit
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
            ,@duration);`);
    }

    const existingEntry = await transaction
      .request()
      .input("Downtime", sql.VarChar, `%${code}%`)
      .input("DateOnly", sql.DateTime, truncatedDate)
      .input("No", sql.VarChar, `${table2Data.uppercasedLine}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.${tableName}
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
        .input("No", sql.VarChar, `${table2Data.uppercasedLine}%`)
        .input("id", sql.VarChar, `${table2Data.id}`).query(`
                  UPDATE dbo.${tableName}
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
              INSERT INTO dbo.${tableName} (
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

      if (cipimpact) {
        await transaction
          .request()
          .input("id", sql.VarChar, tableCIPImpact.id)
          .input("No", sql.VarChar, tableCIPImpact.combined)
          .input("Week", sql.VarChar, date_week)
          .input("Week2", sql.VarChar, date_week)
          .input("Tanggal", sql.DateTime, cipStartTime)
          .input("TypeDowntime", sql.VarChar, tableCIPImpact.typeDowntime)
          .input("Downtime", sql.VarChar, cipimpact.toString()).query(`
              INSERT INTO dbo.${tableName} (
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
  const { id, date_start, line, type, comments, duration, plant } = req.body;
  let pool;
  let transaction;

  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const statusResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query(
        `SELECT id, Minutes, Date FROM [dbo].[tb_reasonDowntime] WHERE id = @id`
      );

    if (statusResult.recordset.length === 0) {
      return res.status(404).json({ message: "Record not found" });
    }

    const stoppageDetails = statusResult.recordset[0];

    // Truncate time part for comparison - keep just the date part
    const truncatedDowntimeDate = new Date(stoppageDetails.Date);

    // Ensure we have a valid date
    if (!truncatedDowntimeDate) {
      return res
        .status(400)
        .json({ message: "Invalid downtime record: missing date" });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();

    // Create a valid date object from the input
    const dateStart = new Date(date_start);
    if (isNaN(dateStart)) {
      return res.status(400).json({ message: "Invalid date_start format" });
    }

    // Format the downtime date properly
    const downtimeDate = new Date(stoppageDetails.Date);
    if (isNaN(downtimeDate)) {
      return res.status(400).json({ message: "Invalid stored date format" });
    }

    const resultReason = await transaction
      .request()
      .input("id", sql.Int, parseInt(id))
      .input("date_start", sql.DateTime, dateStart)
      .input("category", sql.VarChar, type)
      .input("comments", sql.VarChar, comments)
      .input("duration", sql.Float, parseFloat(duration)) // Ensure duration is a float
      .query(`UPDATE dbo.tb_reasonDowntime 
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

    const lineInitial = parseLineInitial(plant, line);
    const idInitial = `${lineInitial}DG`;

    const queryData = `
          UPDATE [dbo].[${tableName}]
          SET Tanggal = @date_start,
          Downtime = @duration
          WHERE ID LIKE @id
          AND Tanggal = @truncatedDate
        `;

    const requestData = pool
      .request()
      .input("id", sql.VarChar, `${idInitial}%`)
      .input("date_start", sql.DateTime, dateStart)
      .input("duration", sql.Float, parseFloat(duration))
      .input("truncatedDate", sql.DateTime, truncatedDowntimeDate); // Use Date type for date-only comparison

    const resultData = await requestData.query(queryData);
    if (resultData.rowsAffected[0] === 0) {
      console.error("No rows were updated. Check query conditions.");
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
  const { id, plant, line } = req.body;

  try {
    const pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

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

      // Check for rowsAffected
      const rowsAffected = result.rowsAffected[0] || 0;
      const truncatedDate = new Date(stoppageDetails.Date);
      const lineInitial = parseLineInitial(plant, line);
      const idInitial = `${lineInitial}DG`;

      const queryData = `
          DELETE FROM [dbo].[${tableName}]
          WHERE ID LIKE @id
          AND Tanggal = @date
        `;

      const requestData = pool
        .request()
        .input("id", sql.VarChar, `${idInitial}%`)
        .input("date", sql.DateTime, truncatedDate);

      const resultData = await requestData.query(queryData);
      if (resultData.rowsAffected[0] === 0) {
        console.error("No rows were updated. Check query conditions.");
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

    const lineInitial = line.toUpperCase();

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
  const { qty, line, startTime, date_week, group, plant } = req.body;

  let pool;
  let result;
  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    // production name based on plant
    const productionName = getProductionName(plant, line);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week, plant);

    const goodValue = qty ? qty.toString() : "0";
    const existingEntry = await pool
      .request()
      .input("DateOnly", sql.DateTime, parsedDateStart)
      .input("No", sql.VarChar, `${parsedLine.line}%`).query(`
              SELECT No, Week, Tanggal, Downtime, TypeDowntime FROM dbo.${tableName}
              WHERE Tanggal = @DateOnly
              AND TypeDowntime LIKE '%${productionName}%'
              AND No LIKE @No;
          `);

    if (existingEntry.recordset && existingEntry.recordset.length > 0) {
      result = await pool
        .request()
        .input("UpdatedQuantity", sql.VarChar, goodValue)
        .input("DateOnly", sql.DateTime, parsedDateStart)
        .input("No", sql.VarChar, `${parsedLine.line}%`)
        .query(`UPDATE dbo.${tableName}
                  SET Downtime = @UpdatedQuantity 
                  WHERE Tanggal = @DateOnly
                  AND TypeDowntime LIKE '%${productionName}%'
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
        .input("group", sql.VarChar, `${group}.${productionName}`)
        .query(`INSERT INTO dbo.${tableName} (
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
  const { speed, nominal, line, startTime, date_week, group, plant } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week, plant);

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
          SELECT Downtime FROM dbo.${tableName}
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
              UPDATE dbo.${tableName}
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
              INSERT INTO dbo.${tableName} (
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
  const { startTime, line, plant } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const lineInitial = parseLineSpeedLoss(line, parsedDateStart, plant);
    const statusResult = await pool
      .request()
      .input("date", sql.DateTime, parsedDateStart)
      .input("line", sql.VarChar, `${lineInitial.combined}`)
      .query(
        `SELECT * FROM [dbo].[${tableName}] WHERE Tanggal = @date AND TypeDowntime LIKE '%SPEED%' AND No LIKE @line`
      );

    if (statusResult.recordset.length > 0) {
      const result = await pool
        .request()
        .input("date", sql.DateTime, parsedDateStart)
        .input("line", sql.VarChar, `${lineInitial.combined}`)
        .query(
          `DELETE FROM [dbo].[${tableName}] WHERE Tanggal = @date AND TypeDowntime LIKE '%SPEED%' AND No LIKE @line`
        );

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

app.get("/getQualityLossProcessingMaster", async (req, res) => {
  try {
    const { sterilizer, tank, step } = req.query;

    let pool = await sql.connect(config);
    const qualityLoss = await pool
      .request()
      .input("sterilizer", sql.VarChar, sterilizer)
      .input("tank", sql.VarChar, tank)
      .input("step", sql.VarChar, step)
      .query(
        `SELECT * FROM dbo.QualityLossProcessingMaster WHERE Sterilizer = @sterilizer AND Tank = @tank AND Step = @step;`
      );

    if (qualityLoss.recordset.length > 0) {
      res.status(200).json(qualityLoss.recordset[0]); // Mengambil objek pertama
    } else {
      res.status(404).json({ message: "Quality Loss not found" });
    }
  } catch (error) {
    console.error("Fetching Quality Loss failed.", error);

    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/insertQualLoss", async (req, res) => {
  const {
    filling = null,
    packing = null,
    sample = null,
    quality = null,
    blowAwal = null,
    drainAkhir = null,
    sirkulasi = null,
    unplannedCip = null,
    line,
    startTime,
    date_week,
    group,
    plant,
  } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart.getTime())) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week, plant);

    const convertValue = (value) => (value !== null ? value.toString() : "0");

    const fillingValue = convertValue(filling);
    const packingValue = convertValue(packing);
    const sampleValue = convertValue(sample);
    const qualityValue = convertValue(quality / 60);
    const blowAwalValue = convertValue(blowAwal);
    const drainAkhirValue = convertValue(drainAkhir);
    const sirkulasiValue = convertValue(sirkulasi);
    const unplannedCipValue = convertValue(unplannedCip);

    const upsertData = async (type, value) => {
      const existingEntry = await pool
        .request()
        .input("DateOnly", sql.DateTime, parsedDateStart)
        .input("No", sql.VarChar, `${parsedLine.line}%`)
        .input("TypeDowntime", sql.VarChar, `%${type}%`).query(`
          SELECT Downtime FROM dbo.${tableName}
          WHERE Tanggal = @DateOnly
          AND TypeDowntime LIKE @TypeDowntime
          AND No LIKE @No;
        `);

      if (existingEntry.recordset.length > 0) {
        // Update existing entry
        await pool
          .request()
          .input("NewDowntime", sql.VarChar, value)
          .input("DateOnly", sql.DateTime, parsedDateStart)
          .input("No", sql.VarChar, `${parsedLine.line}%`)
          .input("TypeDowntime", sql.VarChar, `%${type}%`)
          .input("Type", sql.VarChar, `${group}.${type}`).query(`
            UPDATE dbo.${tableName}
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
          .input("Value", sql.VarChar, value)
          .input("TypeDowntime", sql.VarChar, `${group}.${type}`).query(`
            INSERT INTO dbo.${tableName} (
              ID, No, Week, Week2, Tanggal, Downtime, TypeDowntime, datesystem
            ) VALUES (
              @id, @No, @Week, @Week2, @Tanggal, @Value, @TypeDowntime, GETDATE()
            );
          `);
      }
    };

    await upsertData("Reject filling(Pcs)", fillingValue);
    await upsertData("Reject packing (Pcs)", packingValue);
    await upsertData("Sample (pcs)", sampleValue);
    await upsertData("Quality Losses", qualityValue);
    await upsertData("BLOW AWAL", blowAwalValue);
    await upsertData("DRAIN AKHIR", drainAkhirValue);
    await upsertData("SIRKULASI", sirkulasiValue);
    await upsertData("UNPLANNED CIP", unplannedCipValue);

    return res.json({
      message:
        "Successfully updated or added data for Reject Filling, Reject Packing, Sample, Quality Losses, Blow Awal, Drain Akhir, Sirkulasi, and Unplanned CIP.",
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
    plant,
  } = req.body;

  let pool;
  try {
    pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);
    logger.info(
      `insertPerformance | tableName=${tableName}, plant=${plant}, line=${line}`
    );

    const parsedDateStart = new Date(startTime);
    if (isNaN(parsedDateStart.getTime())) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedLine = parseLine(line, parsedDateStart, date_week, plant);
    logger.info(
      `insertPerformance | combined=${parsedLine.combined}, id=${parsedLine.id}, line=${parsedLine.line}`
    );

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
          SELECT Downtime FROM dbo.${tableName}
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
          SELECT Downtime FROM dbo.${tableName}
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
              UPDATE dbo.${tableName}
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
              UPDATE dbo.${tableName}
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
              INSERT INTO dbo.${tableName} (
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
              INSERT INTO dbo.${tableName} (
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
    logger.error(`insertPerformance | Error: ${error.message}`);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.post("/getQualityLoss", async (req, res) => {
  const { line, date_start, date_end, plant } = req.body;
  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    const lineInitial = parseLineInitial(plant, line);
    const idInitial = `${lineInitial}EG`;

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${idInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.${tableName}
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
  const { line, date_start, date_end, plant } = req.body;
  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    const lineInitial = parseLineSpeedLoss(line, parsedDateStart, plant);

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial.combined}`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd).query(`SELECT 
        CAST(Downtime AS INT) AS Downtime, 
        RIGHT(TypeDowntime, CHARINDEX('.', REVERSE(TypeDowntime)) - 1) AS name
        FROM dbo.${tableName}
        WHERE (
          TypeDowntime LIKE '%.Reject%' 
          OR TypeDowntime LIKE '%.Sample%' 
          OR TypeDowntime LIKE '%.BLOW AWAL%' 
          OR TypeDowntime LIKE '%.DRAIN AKHIR%' 
          OR TypeDowntime LIKE '%.SIRKULASI%' 
          OR TypeDowntime LIKE '%.UNPLANNED CIP%'
        )
        AND No LIKE @line
        AND Tanggal >= @start
        AND Tanggal < @end
        ORDER BY Tanggal;
      `);

    console.log("Reject sample", result.recordset);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getSpeedLoss", async (req, res) => {
  const { line, date_start, date_end, plant } = req.body;

  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    const lineInitial = parseLineInitial(plant, line);
    const idInitial = `${lineInitial}EG`;

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${idInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Tanggal, Downtime FROM dbo.${tableName} 
      WHERE TypeDowntime LIKE '%LOSS SPEED%' 
      AND No LIKE @line
      AND Tanggal >= @start
      AND Tanggal < @end
      order by Tanggal;`);

    console.log("Speed Loss Data: ", result.recordset);
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.post("/getNominalSpeed", async (req, res) => {
  const { line, date_start, date_end, plant } = req.body;
  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    const lineInitial = parseLineSpeedLoss(line, parsedDateStart, plant);

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${lineInitial.combined}`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Tanggal, Downtime FROM dbo.${tableName}
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
  const { line, date_start, date_end, plant } = req.body;

  try {
    let pool = await sql.connect(config);

    // table name based on plant
    const tableName = getTableName(plant, line);

    // production name based on plant
    const productionName = getProductionName(plant, line);

    const parsedDateStart = new Date(date_start);
    if (isNaN(parsedDateStart)) {
      return res.status(400).json({ message: "Invalid date_start" });
    }

    const parsedDateEnd = new Date(date_end);
    if (isNaN(parsedDateEnd)) {
      return res.status(400).json({ message: "Invalid date_end" });
    }

    const lineInitial = parseLineInitial(plant, line);
    const idInitial = `${lineInitial}EG`;

    const result = await pool
      .request()
      .input("line", sql.VarChar, `${idInitial}%`)
      .input("start", sql.DateTime, parsedDateStart)
      .input("end", sql.DateTime, parsedDateEnd)
      .query(`SELECT Downtime FROM dbo.${tableName} 
      WHERE TypeDowntime LIKE '%${productionName}%'
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

    const query = `SELECT id, sku, volume, speed FROM Product WHERE id IN (${idArray
      .map((_, i) => `@id${i}`)
      .join(",")})`;
    const result = await request.query(query);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getGroupByPlant", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { plant } = req.query; // Ambil query parameter 'plant'

    const query = `SELECT * FROM GroupMaster WHERE plant = @plant;`;

    const result = await pool
      .request()
      .input("plant", sql.VarChar, plant)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function getLocalProcessingOrder(plant) {
  const pool = await sql.connect(config);

  const query = `
    SELECT 
      id AS [NO PROCESS ORDER],
      material AS [MATERIAL],
      FORMAT(qty, 'N0') AS [TOTAL QUANTITY / GR],
      status AS [STATUS]   
    FROM ProcessingOrder
    WHERE plant = @plant;
  `;

  const result = await pool
    .request()
    .input("plant", sql.VarChar, plant)
    .query(query);

  const today = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const formattedToday = `${pad(today.getDate())}.${pad(
    today.getMonth() + 1
  )}.${today.getFullYear()}`;

  const processedData = result.recordset.map((item) => ({
    ...item,
    "TANGGAL BASIC DATE START": formattedToday,
    "TIME BASIC DATE START": "00:00:00",
    "TANGGAL BASIC DATE END": formattedToday,
    "TIME BASIC DATE": "00:00:00",
    "TANGGAL SCHEDULED START": formattedToday,
    "TIME SCHEDULED START": "00:00:00",
    "TANGGAL SCHEDULED END": formattedToday,
    "TIME SCHEDULED END": "00:00:00",
  }));

  return processedData;
}

async function getLocalPasteurizerOrder(plant, line) {
  const pool = await sql.connect(config);

  const query = `
    SELECT 
      id AS [NO PROCESS ORDER],
      material AS [MATERIAL],
      FORMAT(qty, 'N0') AS [TOTAL QUANTITY / GR],
      status AS [STATUS]   
    FROM ProductDummy
    WHERE plant = @plant
    AND line = @line;
  `;

  const result = await pool
    .request()
    .input("plant", sql.VarChar, plant)
    .input("line", sql.VarChar, line)
    .query(query);

  const today = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const formattedToday = `${pad(today.getDate())}.${pad(
    today.getMonth() + 1
  )}.${today.getFullYear()}`;

  const processedData = result.recordset.map((item) => ({
    ...item,
    "TANGGAL BASIC DATE START": formattedToday,
    "TIME BASIC DATE START": "00:00:00",
    "TANGGAL BASIC DATE END": formattedToday,
    "TIME BASIC DATE": "00:00:00",
    "TANGGAL SCHEDULED START": formattedToday,
    "TIME SCHEDULED START": "00:00:00",
    "TANGGAL SCHEDULED END": formattedToday,
    "TIME SCHEDULED END": "00:00:00",
  }));

  return processedData;
}

async function getProductDummy(plant) {
  const pool = await sql.connect(config);

  const query = `
    SELECT 
      id AS [NO PROCESS ORDER],
      material AS [MATERIAL],
      FORMAT(qty, 'N0') AS [TOTAL QUANTITY / GR],
      status AS [STATUS]   
    FROM ProductDummy
    WHERE plant = @plant;
  `;

  const result = await pool
    .request()
    .input("plant", sql.VarChar, plant)
    .query(query);

  const today = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const formattedToday = `${pad(today.getDate())}.${pad(
    today.getMonth() + 1
  )}.${today.getFullYear()}`;

  const processedData = result.recordset.map((item) => ({
    ...item,
    "TANGGAL BASIC DATE START": formattedToday,
    "TIME BASIC DATE START": "00:00:00",
    "TANGGAL BASIC DATE END": formattedToday,
    "TIME BASIC DATE": "00:00:00",
    "TANGGAL SCHEDULED START": formattedToday,
    "TIME SCHEDULED START": "00:00:00",
    "TANGGAL SCHEDULED END": formattedToday,
    "TIME SCHEDULED END": "00:00:00",
  }));

  return processedData;
}

app.get("/getProcessingOrder", async (req, res) => {
  try {
    const { plant } = req.query;
    const processedData = await getLocalProcessingOrder(plant);

    res.json(processedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getPasteurizerOrder", async (req, res) => {
  try {
    const { plant, line } = req.query;
    const processedData = await getLocalPasteurizerOrder(plant, line);

    res.json(processedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getProductDummy", async (req, res) => {
  try {
    const { plant } = req.query;
    const processedData = await getProductDummy(plant);

    res.json(processedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/updateStatusDowntimeCILT", async (req, res) => {
  const { id, status } = req.body;
  try {
    let pool = await sql.connect(config);

    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("status", sql.Int, status)
      .query(`UPDATE tb_CILT_downtime SET Completed = @status WHERE id = @id;`);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.get("/getDowntimeFromCILT", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { plant, date, shift, line } = req.query;

    const query = `
      SELECT * FROM tb_CILT_downtime
      WHERE Plant = @plant
        AND CONVERT(date, [Date]) = @date
        AND Shift = @shift
        AND Line = @line
        AND Completed = 0;
    `;

    const result = await pool
      .request()
      .input("plant", sql.VarChar, plant)
      .input("date", sql.VarChar, date)
      .input("shift", sql.VarChar, shift)
      .input("line", sql.VarChar, line)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getHistoryFinishGood", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { plant, line } = req.query;

    const tableName = getTableName(plant, line);
    const productionName = getProductionName(plant, line);
    const lineInitial = parseLineInitial(plant, line);

    const query = `
      SELECT 
        d.Tanggal, 
        d.Downtime, 
        d.TypeDowntime,
        p.product_id,
        prod.sku AS product_sku,
        p.status,
        p.actual_start,
        p.line AS production_line
      FROM dbo.${tableName} d
      INNER JOIN dbo.ProductionOrder p
        ON p.actual_start = d.Tanggal
        AND p.line = @line
      INNER JOIN dbo.Product prod
        ON p.product_id = prod.id
      WHERE CONVERT(date, d.Tanggal) BETWEEN CONVERT(date, DATEADD(DAY, -1, GETDATE())) AND CONVERT(date, GETDATE())
        AND (
          d.TypeDowntime LIKE @productionName OR
          d.TypeDowntime LIKE '%Reject filling(Pcs)%' OR
          d.TypeDowntime LIKE '%Reject packing (Pcs)%' OR
          d.TypeDowntime LIKE '%Sample (pcs)%'
        )
        AND d.No LIKE @lineInitial
      ORDER BY d.Tanggal DESC;
    `;

    const result = await pool
      .request()
      .input("productionName", sql.VarChar, `%${productionName}%`)
      .input("line", sql.VarChar, line.toUpperCase())
      .input("lineInitial", sql.VarChar, `${lineInitial}%`)
      .query(query);

    const groupedData = {};

    result.recordset.forEach((item) => {
      const key = `${item.Tanggal.toISOString()}_${item.product_id}`;

      if (!groupedData[key]) {
        groupedData[key] = {
          tanggal: moment.utc(item.Tanggal).format("DD-MM-YYYY HH:mm:ss"),
          productSku: item.product_sku,
          status: item.status,
          productionLine: item.production_line,
          group: item.TypeDowntime.includes(".")
            ? item.TypeDowntime.split(".")[0]
            : "-",
          quantity: 0,
          rejectFilling: 0,
          rejectPacking: 0,
          sample: 0,
        };
      }

      const type = item.TypeDowntime.toLowerCase();

      if (type.includes(productionName.toLowerCase())) {
        groupedData[key].quantity += Number(item.Downtime);
      } else if (type.includes("reject filling")) {
        groupedData[key].rejectFilling += Number(item.Downtime);
      } else if (type.includes("reject packing")) {
        groupedData[key].rejectPacking += Number(item.Downtime);
      } else if (type.includes("sample")) {
        groupedData[key].sample += Number(item.Downtime);
      }
    });

    const formattedData = Object.values(groupedData);
    res.json(formattedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getFinishGoodLiter", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { plant, line } = req.query;

    const viewName = getViewFinishGoodLiter(plant, line);
    // console.log("table :", viewName);
    const query = `
      SELECT * FROM dbo.${viewName}
      ORDER BY TanggalProduksi DESC;
    `;

    const result = await pool.request().query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getMasterDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { line } = req.query;

    const query = `
      SELECT 
        d.id,
        d.downtime_category AS downtimeCategory,
        d.mesin, 
        d.downtime
      FROM dbo.DowntimeMaster d
      WHERE d.line = @line
      ORDER BY d.id DESC;
    `;

    const result = await pool
      .request()
      .input("line", sql.VarChar, line)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/addMasterDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { line, downtimeCategory, mesin, downtime } = req.body;

    const query = `
      INSERT INTO dbo.DowntimeMaster (line, downtime_category, mesin, downtime, flag, created_at, updated_at)
      VALUES (@line, @downtimeCategory, @mesin, @downtime, 1, GETDATE(), GETDATE());
    `;

    const result = await pool
      .request()
      .input("line", sql.VarChar, line.toUpperCase())
      .input("downtimeCategory", sql.VarChar, downtimeCategory)
      .input("mesin", sql.VarChar, mesin)
      .input("downtime", sql.VarChar, downtime)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/updateMasterDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { id, downtimeCategory, mesin, downtime } = req.body;

    const query = `
      UPDATE dbo.DowntimeMaster
      SET downtime_category = @downtimeCategory, mesin = @mesin, downtime = @downtime
      WHERE id = @id;
    `;

    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("downtimeCategory", sql.VarChar, downtimeCategory)
      .input("mesin", sql.VarChar, mesin)
      .input("downtime", sql.VarChar, downtime)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.delete("/deleteMasterDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { id } = req.body;

    const query = `
      DELETE FROM dbo.DowntimeMaster
      WHERE id = @id;
    `;

    const result = await pool.request().input("id", sql.Int, id).query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//delete PO
app.delete("/delete-po/:id/:line", async (req, res) => {
  const { id, line } = req.params;
  console.log("deleted id :", id);
  try {
    let pool = await sql.connect(config);

    // Query DELETE dari tb_filling_downtime_all2
    await pool
      .request()
      .input("id", sql.VarChar, id)
      .input("line", sql.VarChar, line).query(`
        DELETE FD
        FROM tb_filling_downtime_all2 FD
        JOIN ProductionOrder PO ON CONVERT(DATE, PO.actual_start) = CONVERT(DATE, FD.Tanggal)
        JOIN Product P ON PO.product_id = P.id
        WHERE 
          PO.id = @id AND 
          FD.TypeDowntime COLLATE Latin1_General_CI_AS LIKE '%' + P.sku + '%';
      `);

    // Query DELETE dari ProductionOrder
    await pool
      .request()
      .input("id", sql.VarChar, id)
      .input("line", sql.VarChar, line).query(`
        DELETE FROM ProductionOrder
        WHERE id = @id;
      `);

    res.status(200).json({ message: "Data berhasil dihapus." });
  } catch (error) {
    console.error("Delete PO error:", error);
    res.status(500).json({ error: "Terjadi kesalahan saat menghapus data." });
  }
});

app.get("/getMachineDowntime", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { line } = req.query;

    const query = `
      SELECT DISTINCT
        d.mesin
      FROM dbo.DowntimeMaster d
      WHERE d.line = @line
      AND d.downtime_category = 'Breakdown/Minor Stop';
    `;

    const result = await pool
      .request()
      .input("line", sql.VarChar, line.toUpperCase())
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getMasterCILT", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { plant } = req.query;

    const query = `
      SELECT *
      FROM tb_CILT_master
      WHERE plant = @plant 
      ORDER BY id DESC;
    `;

    const result = await pool
      .request()
      .input("plant", sql.VarChar, plant)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/addMasterCILT", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const data = req.body;

    const query = `
      INSERT INTO tb_CILT_master (cilt, type, ci, activity, min, max, frekwensi, content, image, plant, line, status, good, need, red)
      OUTPUT inserted.id
      VALUES (@cilt, @type, @ci, @activity, @min, @max, @frekwensi, @content, @image, @plant, @line, @status, @good, @need, @red);
    `;

    const result = await pool
      .request()
      .input("cilt", sql.VarChar, data.cilt)
      .input("type", sql.VarChar, data.type)
      .input("ci", sql.VarChar, data.ci)
      .input("activity", sql.VarChar, data.activity)
      .input("min", sql.VarChar, "-")
      .input("max", sql.VarChar, "-")
      .input("frekwensi", sql.VarChar, data.frekwensi)
      .input("content", sql.VarChar, data.content)
      .input("image", sql.VarChar, data.image)
      .input("plant", sql.NVarChar, data.plant)
      .input("line", sql.NVarChar, data.line)
      .input("status", sql.VarChar, data.status)
      .input("good", sql.Float, data.good)
      .input("need", sql.Float, data.need)
      .input("red", sql.Float, data.red)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/updateMasterCILT", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const data = req.body;

    if (data.status === "0") {
      data.good = null;
      data.need = null;
      data.red = null;
    }

    const query = `
      UPDATE tb_CILT_master
      SET cilt = @cilt, type = @type, ci = @ci, activity = @activity, min = @min, max = @max, 
          frekwensi = @frekwensi, content = @content, image = @image, plant = @plant, 
          line = @line, status = @status, good = @good, need = @need, red = @red
      WHERE id = @id;
    `;

    const result = await pool
      .request()
      .input("id", sql.Int, data.id)
      .input("cilt", sql.VarChar, data.cilt)
      .input("type", sql.VarChar, data.type)
      .input("ci", sql.VarChar, data.ci)
      .input("activity", sql.VarChar, data.activity)
      .input("min", sql.VarChar, "-")
      .input("max", sql.VarChar, "-")
      .input("frekwensi", sql.VarChar, data.frekwensi)
      .input("content", sql.VarChar, data.content)
      .input("image", sql.VarChar, data.image)
      .input("plant", sql.NVarChar, data.plant)
      .input("line", sql.NVarChar, data.line)
      .input("status", sql.VarChar, data.status)
      .input("good", sql.Float, data.good)
      .input("need", sql.Float, data.need)
      .input("red", sql.Float, data.red)
      .query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.delete("/deleteMasterCILT", async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const { id } = req.body;

    const query = `
      DELETE FROM tb_CILT_master
      WHERE id = @id;
    `;

    const result = await pool.request().input("id", sql.Int, id).query(query);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
