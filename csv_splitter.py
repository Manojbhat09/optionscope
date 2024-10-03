import csv
import math
import argparse
import os
from typing import List, Tuple
from collections import Counter
import random
import datetime

def standardize_date(date_str):
    try:
        date_obj = datetime.datetime.strptime(date_str, '%m/%d/%Y')
        return date_obj.strftime('%Y-%m-%d')
    except ValueError:
        try:
            date_obj = datetime.datetime.strptime(date_str, '%d/%m/%Y')
            return date_obj.strftime('%Y-%m-%d')
        except ValueError:
            return date_str

def analyze_csv(file_path: str, delimiter: str = ',', quotechar: str = '"', sample_size: int = 5) -> dict:
    """
    Analyze the contents of a CSV file.
    
    :param file_path: Path to the CSV file
    :param delimiter: CSV delimiter character
    :param quotechar: CSV quote character
    :param sample_size: Number of sample rows to display
    :return: Dictionary containing analysis results
    """
    with open(file_path, 'r', newline='', encoding='utf-8') as file:
        reader = csv.reader(file, delimiter=delimiter, quotechar=quotechar)
        headers = next(reader)
        rows = list(reader)

    analysis = {
        "total_rows": len(rows) + 1,  # Include header row
        "total_columns": len(headers),
        "headers": headers,
        "column_types": [],
        "non_empty_counts": [],
        "sample_rows": random.sample(rows, min(sample_size, len(rows))),
        "inconsistent_rows": 0,
    }

    for col in range(len(headers)):
        column_data = []
        for row in rows:
            if col < len(row):
                value = row[col].strip()
                if value:
                    column_data.append(value)
            else:
                analysis["inconsistent_rows"] += 1

        non_empty_count = len(column_data)
        analysis["non_empty_counts"].append(non_empty_count)

        # Determine column type
        if all(value.replace('.', '').isdigit() for value in column_data):
            col_type = "numeric"
        elif all(value.lower() in ['true', 'false', 'yes', 'no', '0', '1'] for value in column_data):
            col_type = "boolean"
        else:
            col_type = "string"
        analysis["column_types"].append(col_type)

    return analysis

def print_analysis(analysis: dict) -> None:
    """
    Print the analysis results in a formatted manner.
    
    :param analysis: Dictionary containing analysis results
    """
    print(f"CSV File Analysis:")
    print(f"Total rows: {analysis['total_rows']}")
    print(f"Total columns: {analysis['total_columns']}")
    print(f"Inconsistent rows: {analysis['inconsistent_rows']}")
    print("\nHeaders:")
    for i, header in enumerate(analysis['headers']):
        print(f"  {i+1}. {header} (Type: {analysis['column_types'][i]}, Non-empty: {analysis['non_empty_counts'][i]})")
    
    print("\nSample rows:")
    for i, row in enumerate(analysis['sample_rows']):
        print(f"  Row {i+1}: {row}")

def split_csv(input_file: str, output_files: List[str], split_points: List[int], 
               has_header: bool = False, delimiter: str = ',', quotechar: str = '"') -> None:
    """
    Split a CSV file into multiple parts based on specified split points.
    
    :param input_file: Path to the input CSV file
    :param output_files: List of output file paths
    :param split_points: List of row numbers where to split the file
    :param has_header: Whether the CSV has a header row
    :param delimiter: CSV delimiter character
    :param quotechar: CSV quote character
    """
    with open(input_file, 'r', newline='') as file:
        reader = csv.reader(file, delimiter=delimiter, quotechar=quotechar)
        rows = list(reader)
    
    total_rows = len(rows)
    header = rows[0] if has_header else None

    print(f"Selecting header as: {header}")
    print(f"If this is not correct, return this script with appropriate flag for header")
    
    split_points = [0] + split_points + [total_rows]
    for i in range(len(output_files)):
        start = split_points[i]
        end = split_points[i+1]
        
        with open(output_files[i], 'w', newline='') as outfile:
            writer = csv.writer(outfile, delimiter=delimiter, quotechar=quotechar)
            if has_header:
                writer.writerow([standardize_date(cell) if '/' in cell else cell for cell in header])
            else:
                print("Doesnt have the header")
            writer.writerows([[standardize_date(cell) if '/' in cell else cell for cell in row] for row in rows[start:end]])

def get_file_info(file_path: str, delimiter: str = ',', quotechar: str = '"') -> Tuple[int, List[str]]:
    """
    Get information about the CSV file.
    
    :param file_path: Path to the CSV file
    :param delimiter: CSV delimiter character
    :param quotechar: CSV quote character
    :return: Tuple of (number of rows, list of column names)
    """
    with open(file_path, 'r', newline='') as file:
        reader = csv.reader(file, delimiter=delimiter, quotechar=quotechar)
        header = next(reader)
        row_count = sum(1 for _ in reader) + 1  # +1 to include header
    return row_count, header

def fix_cusip_lines(input_file, delimiter=',', quotechar='"'):
    with open(input_file, 'r') as file:
        lines = file.readlines()

    fixed_lines = []
    for line in lines:
        if line.lstrip().startswith('CUSIP:'):
            if fixed_lines:
                fixed_lines[-1] = fixed_lines[-1].strip() + ' ' + line.strip() + '\n'
            else:
                fixed_lines.append(line)
        else:
            fixed_lines.append(line)

    with open(input_file, 'w') as file:
        file.writelines(fixed_lines)

    print(f"Fixed CUSIP lines in {input_file}")

def main():
    parser = argparse.ArgumentParser(description="Split a CSV file into multiple parts.")
    parser.add_argument("input_file", help="Path to the input CSV file")
    parser.add_argument("-o", "--output", nargs="+", help="Output file names (default: output1.csv, output2.csv, ...)")
    parser.add_argument("-n", "--num-parts", type=int, default=2, help="Number of parts to split into (default: 2)")
    parser.add_argument("-s", "--split-points", type=int, nargs="+", help="Specific row numbers to split at")
    parser.add_argument("--header", action="store_true", help="CSV has a header row")
    parser.add_argument("--delimiter", default=",", help="CSV delimiter (default: ,)")
    parser.add_argument("--quotechar", default='"', help="CSV quote character (default: \")")
    parser.add_argument("--info", action="store_true", help="Display information about the CSV file")
    parser.add_argument("--prefix", help="Prefix for output files (default: 'output')")
    parser.add_argument("--analyze", action="store_true", help="Analyze the CSV file without splitting")
    parser.add_argument("--sample-size", type=int, default=5, help="Number of sample rows to display in analysis (default: 5)")    
    args = parser.parse_args()

    fix_cusip_lines(args.input_file)
    # Analyze the CSV file
    analysis = analyze_csv(args.input_file, args.delimiter, args.quotechar, args.sample_size)
    print_analysis(analysis)

    if args.analyze:
        return    

    if args.info:
        row_count, columns = get_file_info(args.input_file, args.delimiter, args.quotechar)
        print(f"File: {args.input_file}")
        print(f"Total rows: {row_count}")
        print(f"Columns: {', '.join(columns)}")
        return

    if args.split_points:
        num_parts = len(args.split_points) + 1
    else:
        num_parts = args.num_parts
        total_rows = get_file_info(args.input_file, args.delimiter, args.quotechar)[0]
        rows_per_part = math.ceil(total_rows / num_parts)
        args.split_points = [i * rows_per_part for i in range(1, num_parts)]

    if args.output:
        output_files = args.output
        if len(output_files) != num_parts:
            raise ValueError(f"Number of output files ({len(output_files)}) doesn't match the number of parts ({num_parts})")
    else:
        prefix = args.prefix or "output"
        output_files = [f"{prefix}{i+1}.csv" for i in range(num_parts)]

    split_csv(args.input_file, output_files, args.split_points, args.header, args.delimiter, args.quotechar)
    print(f"Split {args.input_file} into {num_parts} parts:")
    for file in output_files:
        print(f"- {file}")

if __name__ == "__main__":
    main()
